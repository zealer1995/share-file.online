import "./style.css";
import { SignalingService } from "./services/signaling.js";
import { FAQ_INTRO, FAQ_ITEMS } from "./faqContent.js";
import {
  DC_BUFFER_HIGH_WATER_MARK,
  DC_BUFFER_LOW_WATER_MARK,
  FILE_CHUNK_SIZE,
  FILE_FRAME_HEADER_BYTES,
  PeerClient,
  UI_PROGRESS_MIN_INTERVAL_MS,
  createAbortError,
  getBinaryByteLength,
  getFastFileChannelCount,
  isAbortError,
  isDcSendQueueFullError,
  normalizeLanIpOverride,
  nowMs,
  streamIdMatchesBase,
  webrtcConfig,
  setForceTurnRelay,
  setLanIpOverrideValue,
  setTurnCredential,
  setTurnUrl,
  setTurnUsername,
  setUseFastTransfer,
  setUseFileUnordered,
  setUseLanIpOverride,
  setUseSignalCompression,
  setUseStun,
  setUseTurn,
} from "./webrtc/peerClient.js";

/* =========================================
   Configuration & Constants
   ========================================= */

// Loaded from .env file (Vite)
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || "";

// Check if configured
const isSupabaseConfigured = () => SUPABASE_URL && SUPABASE_URL.startsWith("http") && SUPABASE_KEY;

// Expose runtime toggles for debugging/configuration (keeps previous API surface).
window.setUseStun = setUseStun;
window.setUseSignalCompression = setUseSignalCompression;
window.setUseFileUnordered = setUseFileUnordered;
window.setUseFastTransfer = setUseFastTransfer;
window.setUseLanIpOverride = setUseLanIpOverride;
window.setLanIpOverrideValue = setLanIpOverrideValue;
window.setUseTurn = setUseTurn;
window.setTurnUrl = setTurnUrl;
window.setTurnUsername = setTurnUsername;
window.setTurnCredential = setTurnCredential;
window.setForceTurnRelay = setForceTurnRelay;

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function copyToClipboard(text) {
  const value = String(text ?? "");
  if (!value) return;

  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-9999px";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("Copy failed");
  } finally {
    ta.remove();
  }
}

const outgoingQueue = [];
const outgoingQueuedIds = new Set();
let outgoingRunning = false;
const outgoingCancelledIds = new Set(); // fileId cancelled before start
const outgoingTransfers = new Map(); // fileId -> { controller, metaSent }

function enqueueOutgoingFile(id) {
  if (outgoingQueuedIds.has(id)) return Promise.resolve();
  outgoingQueuedIds.add(id);

  return new Promise((resolve, reject) => {
    outgoingQueue.push({ id, resolve, reject });
    void processOutgoingQueue();
  });
}

async function processOutgoingQueue() {
  if (outgoingRunning) return;
  outgoingRunning = true;

  try {
    while (outgoingQueue.length) {
      const job = outgoingQueue.shift();
      if (!job) continue;
      const { id, resolve, reject } = job;
      try {
        if (outgoingCancelledIds.has(id)) throw createAbortError();
        await doSendFile(id);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        outgoingQueuedIds.delete(id);
        outgoingCancelledIds.delete(id);
      }
    }
  } finally {
    outgoingRunning = false;
  }
}

const fileAcceptWaiters = new Map(); // id -> { resolve, reject }
const fileAcceptEarly = new Set(); // id accepted before waiter is registered (race-safe)

function resolveFileAccept(id) {
  const fileId = String(id ?? "").trim();
  if (!fileId) return;
  const waiter = fileAcceptWaiters.get(fileId);
  if (!waiter) {
    // Only keep early accepts for active outgoing transfers; ignore stale/duplicate accepts.
    if (outgoingTransfers.has(fileId)) fileAcceptEarly.add(fileId);
    return;
  }
  waiter.resolve();
}

function rejectFileAccept(id, err) {
  const fileId = String(id ?? "").trim();
  if (!fileId) return;
  const waiter = fileAcceptWaiters.get(fileId);
  if (!waiter) return;
  waiter.reject(err);
}

function waitForFileAccept(id, timeoutMs = 10 * 60 * 1000, { signal } = {}) {
  const fileId = String(id ?? "").trim();
  if (!fileId) return Promise.reject(new Error("Missing file id"));
  if (fileAcceptEarly.has(fileId)) {
    fileAcceptEarly.delete(fileId);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (fileAcceptWaiters.has(fileId)) {
      reject(new Error("Duplicate accept waiter"));
      return;
    }

    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    let done = false;
    let timeoutId = 0;

    const cleanup = () => {
      if (done) return;
      done = true;
      fileAcceptWaiters.delete(fileId);
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the other side to accept."));
    }, timeoutMs);

    fileAcceptWaiters.set(fileId, {
      resolve: () => {
        cleanup();
        resolve();
      },
      reject: (err) => {
        cleanup();
        reject(err);
      },
    });
  });
}

const fileDoneWaiters = new Map(); // id -> { resolve, reject }

function resolveFileDone(id) {
  const waiter = fileDoneWaiters.get(id);
  if (!waiter) return;
  waiter.resolve();
}

function rejectFileDone(id, err) {
  const waiter = fileDoneWaiters.get(id);
  if (!waiter) return;
  waiter.reject(err);
}

function waitForFileDone(id, timeoutMs = 10 * 60 * 1000, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (fileDoneWaiters.has(id)) {
      reject(new Error("Duplicate done waiter"));
      return;
    }

    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    let done = false;
    let timeoutId = 0;

    const cleanup = () => {
      if (done) return;
      done = true;
      fileDoneWaiters.delete(id);
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for confirmation."));
    }, timeoutMs);

    fileDoneWaiters.set(id, {
      resolve: () => {
        cleanup();
        resolve();
      },
      reject: (err) => {
        cleanup();
        reject(err);
      },
    });
  });
}

function ensureFileStatusEl(el) {
  const info = el.querySelector(".file-info");
  if (!info) return null;

  let status = el.querySelector(".file-status-text");
  if (!status) {
    status = document.createElement("div");
    status.className = "file-status-text";
    info.appendChild(status);
  }
  return status;
}

function getDcMaxMessageSize() {
  const max = peer?.pc?.sctp?.maxMessageSize;
  return Number.isFinite(max) && max > 0 ? max : 0;
}

function getSendChunkSize(overheadBytes = 0) {
  const max = getDcMaxMessageSize();
  const base = max ? Math.min(FILE_CHUNK_SIZE, Math.floor(max)) : FILE_CHUNK_SIZE;
  const overhead = Math.max(0, Math.floor(overheadBytes) || 0);
  return Math.max(1, base - overhead);
}

async function doSendFile(id) {
  const file = stagedFiles.get(id);
  if (!file) return;
  if (!peer?.dc || peer.dc.readyState !== "open") {
    throw new Error("Connection not established");
  }

  if (outgoingCancelledIds.has(id)) throw createAbortError();

  const controller = new AbortController();
  outgoingTransfers.set(id, { controller, metaSent: false });
  const signal = controller.signal;
  const waitAck = webrtcConfig.useUnorderedFileChannel;
  try {
    let streamCount = 1;
    if (webrtcConfig.useFastTransfer) {
      const remoteCaps = await peer.waitForRemoteCaps({ timeoutMs: 1200 });
      const desired = getFastFileChannelCount();
      if (remoteCaps?.striping && desired > 1) streamCount = desired;
    }

    const fileDcs = await peer.ensureFileTxChannels({ count: streamCount });
    if (signal.aborted) throw createAbortError();
    
    // UI Update: Sending Started (Metadata)
    const el = document.getElementById(`file-${id}`);
    if (el) {
       const actionBtn = el.querySelector('.btn-action');
       if (actionBtn) actionBtn.style.display = 'none';
  
       ensureFileStatusEl(el);
    }
  
    // Send Meta
    peer.send(JSON.stringify({ 
      type: 'file-meta', id, sid: peer.getFileTxId(), sc: streamCount, name: file.name, size: file.size 
    }));
    const outState = outgoingTransfers.get(id);
    if (outState) outState.metaSent = true;

    // Always wait for receiver to confirm and pick a save location before sending.
    if (el) {
      const status = ensureFileStatusEl(el);
      if (status) status.textContent = "Waiting for the other side to accept...";
    }
    await waitForFileAccept(id, 10 * 60 * 1000, { signal });
  
    // Send chunks
    await sendFileChunks(id, fileDcs, signal);

    if (waitAck) {
      const status = document.getElementById(`file-${id}`)?.querySelector?.(".file-status-text");
      if (status) status.textContent = "Waiting for confirmation...";
      await waitForFileDone(id, 10 * 60 * 1000, { signal });
      const doneStatus = document.getElementById(`file-${id}`)?.querySelector?.(".file-status-text");
      if (doneStatus) doneStatus.textContent = "✅ Received";
    }
  } finally {
    outgoingTransfers.delete(id);
  }
}

window.startSend = async (id) => {
  const file = stagedFiles.get(id);
  if (!file) return;

  if (!peer?.dc || peer.dc.readyState !== "open") {
    const el = document.getElementById(`file-${id}`);
    if (el) {
      const status = ensureFileStatusEl(el);
      if (status) status.textContent = "Waiting for connection...";
    }
    alert("Connection not established.");
    return;
  }

  const el = document.getElementById(`file-${id}`);
  if (el) {
    const status = ensureFileStatusEl(el);
    if (status) status.textContent = "Queued";
  }

  try {
    await enqueueOutgoingFile(id);
  } catch (err) {
    if (isAbortError(err)) {
      const el = document.getElementById(`file-${id}`);
      if (el) {
        const status = ensureFileStatusEl(el);
        if (status) status.textContent = "Canceled";
      }
      return;
    }
    console.error(err);
    const el = document.getElementById(`file-${id}`);
    if (el) {
      const status = ensureFileStatusEl(el);
      if (status) status.textContent = "Send failed (you can retry)";

      let actionBtn = el.querySelector(".btn-action");
      if (!actionBtn) {
        actionBtn = document.createElement("button");
        actionBtn.className = "btn btn-primary btn-action";
        actionBtn.style.cssText = "padding:4px 12px; font-size:12px; width:auto; margin-top:4px; background:var(--surface-strong); border:1px solid var(--glass-border); color:var(--text-main); box-shadow:none";
        actionBtn.onclick = () => window.startSend(id);
        el.querySelector(".file-info")?.appendChild(actionBtn);
      }
      actionBtn.textContent = "Retry";
      actionBtn.style.display = "";
    }
    alert(`Failed to send file: ${err?.message ?? String(err)}`);
  }
};

function updateFileItemStatus(id, text) {
  const el = document.getElementById(`file-${id}`);
  if (!el) return;
  const status = ensureFileStatusEl(el);
  if (status) status.textContent = String(text ?? "");
}

function cancelQueuedOutgoingJob(id, reason = "Canceled") {
  const idx = outgoingQueue.findIndex((job) => job?.id === id);
  if (idx < 0) return false;

  const [job] = outgoingQueue.splice(idx, 1);
  outgoingQueuedIds.delete(id);
  outgoingCancelledIds.delete(id);
  try { job?.reject?.(createAbortError(reason)); } catch {}
  return true;
}

function cancelOutgoingFile(id, { notifyPeer = true, reason = "Canceled" } = {}) {
  const fileId = String(id ?? "").trim();
  if (!fileId) return;

  // Pending (not queued yet)
  if (!outgoingTransfers.has(fileId) && !outgoingQueuedIds.has(fileId)) {
    stagedFiles.delete(fileId);
    document.getElementById(`file-${fileId}`)?.remove();
    return;
  }

  updateFileItemStatus(fileId, reason);
  fileAcceptEarly.delete(fileId);
  const el = document.getElementById(`file-${fileId}`);
  if (el) {
    el.querySelector(".btn-cancel")?.remove();
    let actionBtn = el.querySelector(".btn-action");
    if (!actionBtn) {
      actionBtn = document.createElement("button");
      actionBtn.className = "btn btn-primary btn-action";
      actionBtn.style.cssText = "padding:4px 12px; font-size:12px; width:auto; margin-top:4px; background:var(--surface-strong); border:1px solid var(--glass-border); color:var(--text-main); box-shadow:none";
      el.querySelector(".file-info")?.appendChild(actionBtn);
    }
    actionBtn.textContent = "Send again";
    actionBtn.onclick = () => window.startSend(fileId);
    actionBtn.style.display = "";
  }

  // Active transfer
  const state = outgoingTransfers.get(fileId);
  if (state) {
    if (notifyPeer && state.metaSent && peer?.dc?.readyState === "open") {
      try { peer.send(JSON.stringify({ type: "file-cancel", id: fileId, reason })); } catch {}
    }
    try { rejectFileAccept(fileId, createAbortError(reason)); } catch {}
    try { state.controller.abort(createAbortError(reason)); } catch {}
    try { peer?.resetFileTxChannel?.(); } catch {}
    return;
  }

  // Queued transfer (waiting to start)
  if (cancelQueuedOutgoingJob(fileId, reason)) return;
  outgoingCancelledIds.add(fileId);
}

function cancelIncomingFile(id, { notifyPeer = true, reason = "Canceled" } = {}) {
  const fileId = String(id ?? "").trim();
  if (!fileId) return;
  const state = incomingFiles.get(fileId);
  if (!state) return;

  state.cancelled = true;
  if (state.acceptResendTimer) {
    try { clearInterval(state.acceptResendTimer); } catch {}
    state.acceptResendTimer = 0;
  }
  incomingFiles.delete(fileId);
  if (peer?.receiving?.id === fileId) peer.receiving = null;

  if (notifyPeer && peer?.dc?.readyState === "open") {
    try { peer.send(JSON.stringify({ type: "file-cancel", id: fileId, reason })); } catch {}
  }

  if (state.streamId) {
    try { peer?.closeFileChannelsByPrefix?.(state.streamId); } catch {}
  }

  try { state.writer?.abort?.(); } catch {}
  try { state.writer?.close?.(); } catch {}
  state.writer = null;
  state.writeQueue = [];
  state.writeQueueStart = 0;
  state.writeQueuedBytes = 0;

  updateFileItemStatus(fileId, reason);
  const el = document.getElementById(`file-${fileId}`);
  if (el) {
    el.querySelector(".btn-cancel")?.remove();
    el.querySelector(".btn-accept")?.remove();
  }
}

window.cancelSend = (id) => cancelOutgoingFile(id, { notifyPeer: true, reason: "Canceled" });
window.cancelReceive = (id) => cancelIncomingFile(id, { notifyPeer: true, reason: "Canceled" });

async function sendFileChunks(id, fileDcs, signal) {
  const file = stagedFiles.get(id);
  if (!file) return;
  if (!peer?.dc || peer.dc.readyState !== "open") {
    throw new Error("Connection not established");
  }
  const channels = (Array.isArray(fileDcs) ? fileDcs : [fileDcs]).filter(Boolean);
  const getOpenChannels = () => channels.filter((dc) => dc?.readyState === "open");
  if (!getOpenChannels().length) {
    throw new Error("File channel not ready");
  }
  if (signal?.aborted) throw createAbortError();

  const payloadChunkSize = getSendChunkSize(FILE_FRAME_HEADER_BYTES);
  const minHighWaterMark = Math.max(1 * 1024 * 1024, payloadChunkSize * 4);
  const channelCount = getOpenChannels().length;
  const totalHighWaterMark = Math.max(DC_BUFFER_HIGH_WATER_MARK, minHighWaterMark * channelCount);
  let highWaterMark = Math.max(minHighWaterMark, Math.floor(totalHighWaterMark / channelCount));
  let lowWaterMark = Math.max(512 * 1024, Math.floor(highWaterMark / 4));

  for (const dc of channels) {
    try { dc.bufferedAmountLowThreshold = lowWaterMark; } catch {}
  }

  const waitForAnyBuffer = async (
    dcs,
    { highWaterMark = 0, lowWaterMark = 0, timeoutMs = 10_000, signal } = {}
  ) => {
    const open = dcs.filter((dc) => dc?.readyState === "open");
    if (!open.length) return;
    const high = Math.max(0, Math.floor(highWaterMark) || 0);
    const low = Math.max(0, Math.floor(lowWaterMark) || 0);
    const timeout = Math.max(0, Math.floor(timeoutMs) || 0);
    if (open.some((dc) => dc.bufferedAmount < high)) return;

    return new Promise((resolve, reject) => {
      let iv = 0;
      let timeoutId = 0;
      let aborted = false;
      let done = false;
      const listeners = new Map();

      const cleanup = () => {
        if (done) return;
        done = true;
        for (const [dc, fn] of listeners) {
          try { dc.removeEventListener("bufferedamountlow", fn); } catch {}
        }
        if (signal) signal.removeEventListener("abort", onAbort);
        if (iv) clearInterval(iv);
        if (timeoutId) clearTimeout(timeoutId);
        if (aborted) reject(createAbortError());
        else resolve();
      };

      const onAbort = () => {
        aborted = true;
        cleanup();
      };

      const check = () => {
        if (signal?.aborted) return onAbort();
        let anyOpen = false;
        for (const dc of open) {
          if (dc.readyState !== "open") continue;
          anyOpen = true;
          if (dc.bufferedAmount <= low) return cleanup();
        }
        if (!anyOpen) return cleanup();
      };

      for (const dc of open) {
        const onLow = () => check();
        listeners.set(dc, onLow);
        dc.addEventListener("bufferedamountlow", onLow, { once: true });
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      iv = setInterval(check, 50);
      if (timeout) timeoutId = setTimeout(cleanup, timeout);
      check();
    });
  };

  const headerBuf = new ArrayBuffer(FILE_FRAME_HEADER_BYTES);
  const headerView = new DataView(headerBuf);

  const el = document.getElementById(`file-${id}`);
  const statusEl = el?.querySelector?.(".file-status-text") || null;
  const speedStartAt = nowMs();
  let speedLastAt = speedStartAt;
  let speedLastBytes = 0;
  const updateSpeedText = (sentBytes) => {
    if (!statusEl) return;
    const now = nowMs();
    const dt = now - speedLastAt;
    if (dt < 400) return;
    const delta = Math.max(0, sentBytes - speedLastBytes);
    const bps = dt > 0 ? (delta * 1000) / dt : 0;
    speedLastAt = now;
    speedLastBytes = sentBytes;
    statusEl.textContent = `Sending... ${formatBytes(bps)}/s`;
  };
  if (el) {
    if (statusEl) statusEl.textContent = "Sending...";
    const progressBar = el.querySelector(".progress-bar");
    if (progressBar) progressBar.style.display = "block";
  }

  // Handle empty file
  if (file.size === 0) {
    if (signal?.aborted) throw createAbortError();
    const dc0 = getOpenChannels()[0];
    if (!dc0) throw new Error("File channel not ready");
    await peer.waitForBuffer(dc0, { highWaterMark, lowWaterMark, signal });
    headerView.setUint32(0, 0);
    headerView.setUint32(4, 0);
    while (true) {
      if (signal?.aborted) throw createAbortError();
      try {
        dc0.send(headerBuf);
        break;
      } catch (err) {
        if (!isDcSendQueueFullError(err)) throw err;
        await peer.waitForBuffer(dc0, { highWaterMark: 0, lowWaterMark: 0, timeoutMs: 20_000, signal });
      }
    }
    updateProgress(id, 1);

    if (el) {
      const status = el.querySelector(".file-status-text");
      if (status) status.textContent = "Sent";
      el.querySelector(".btn-cancel")?.remove();
    }
    stagedFiles.delete(id);
    return;
  }

  let offset = 0;
  let seq = 0;
  let rrIndex = 0;
  const uiStep = webrtcConfig.useFastTransfer ? 4 * 1024 * 1024 : 2 * 1024 * 1024; // Update UI every ~2-4MB
  let nextUiUpdateAt = uiStep;

  const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));
  const timeBudgetMs = webrtcConfig.useFastTransfer ? 180 : 32;

  const hasBackpressureEverywhere = () => {
    const open = getOpenChannels();
    if (!open.length) return null;
    for (const dc of open) {
      if (dc.bufferedAmount < highWaterMark) return false;
    }
    return true;
  };

  const pickChannel = () => {
    const n = channels.length;
    for (let i = 0; i < n; i++) {
      const idx = (rrIndex + i) % n;
      const dc = channels[idx];
      if (!dc || dc.readyState !== "open") continue;
      if (dc.bufferedAmount < highWaterMark) {
        rrIndex = (idx + 1) % n;
        return dc;
      }
    }
    return null;
  };

  try {
    while (offset < file.size) {
      if (signal?.aborted) throw createAbortError();
      if (!peer?.dc || peer.dc.readyState !== "open") {
        throw new Error("Connection lost");
      }
      if (!getOpenChannels().length) {
        throw new Error("File channel closed");
      }

      const allFull = hasBackpressureEverywhere();
      if (allFull) {
        await waitForAnyBuffer(channels, { highWaterMark, lowWaterMark, signal });
        continue;
      }
      if (allFull === null) throw new Error("File channel closed");

      const deadline = nowMs() + timeBudgetMs;
      let hitBackpressure = false;

      while (offset < file.size && nowMs() < deadline) {
        if (signal?.aborted) throw createAbortError();
        if (!peer?.dc || peer.dc.readyState !== "open") {
          throw new Error("Connection lost");
        }

        const dc = pickChannel();
        if (!dc) {
          hitBackpressure = true;
          break;
        }

        const end = Math.min(offset + payloadChunkSize, file.size);
        const payloadLen = Math.max(0, end - offset);
        headerView.setUint32(0, seq);
        headerView.setUint32(4, payloadLen);
        const frame = new Blob([headerBuf, file.slice(offset, end)]);
        try {
          dc.send(frame);
        } catch (err) {
          if (!isDcSendQueueFullError(err)) throw err;
          // Browser send queue hit hard limit: reduce pacing and drain aggressively.
          highWaterMark = Math.max(minHighWaterMark, Math.floor(highWaterMark / 2));
          lowWaterMark = Math.max(512 * 1024, Math.floor(highWaterMark / 4));
          for (const c of channels) {
            try { c.bufferedAmountLowThreshold = lowWaterMark; } catch {}
          }
          const drainTarget = Math.min(lowWaterMark, 1024 * 1024);
          await waitForAnyBuffer(channels, {
            highWaterMark: drainTarget,
            lowWaterMark: drainTarget,
            timeoutMs: 20_000,
            signal,
          });
          hitBackpressure = true;
          break;
        }
        offset = end;
        seq += 1;

        if (offset >= nextUiUpdateAt) {
          updateProgress(id, offset / file.size);
          updateSpeedText(offset);
          nextUiUpdateAt = offset + uiStep;
        }
      }

      if (offset >= file.size) break;
      if (hitBackpressure) {
        await waitForAnyBuffer(channels, { highWaterMark, lowWaterMark, signal });
        continue;
      }
      await yieldToMain();
    }

    updateProgress(id, 1);
    if (el) {
      const status = el.querySelector(".file-status-text");
      if (status) status.textContent = "Sent";
      el.querySelector(".btn-cancel")?.remove();
    }
    stagedFiles.delete(id);
  } catch (err) {
    if (!isAbortError(err)) console.error(err);
    if (el) {
      const status = el.querySelector(".file-status-text");
      if (status) status.textContent = isAbortError(err) ? "Canceled" : "Transfer interrupted";
    }
    throw err;
  }
}

// --- UI Logic (ViewManager) ---
const app = document.getElementById("app-view-root");
let peer = null;
let signaling = new SignalingService(SUPABASE_URL, SUPABASE_KEY);
let currentRole = null; // 'sender' | 'receiver'
let flowGeneration = 0;

// Some deployments enable strict CSP which blocks inline event handlers (onclick/oninput...).
// Use delegated listeners so the UI remains interactive in those environments.
function getEventTargetElement(evt) {
  const t = evt?.target;
  if (!t) return null;
  if (t.nodeType === 1) return t; // ELEMENT_NODE
  if (t.nodeType === 3) return t.parentElement; // TEXT_NODE
  return null;
}

function findActionElement(evt, root) {
  const r = root || null;
  const path = typeof evt?.composedPath === "function" ? evt.composedPath() : null;
  if (Array.isArray(path)) {
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      if (r && !r.contains(node)) continue;
      const action = node.getAttribute?.("data-action");
      if (action) return node;
    }
  }

  let cur = getEventTargetElement(evt);
  while (cur && cur.nodeType === 1) {
    if (r && !r.contains(cur)) return null;
    const action = cur.getAttribute?.("data-action");
    if (action) return cur;
    cur = cur.parentElement;
  }
  return null;
}

document.addEventListener(
  "click",
  (e) => {
    if (!app) return;
    const el = findActionElement(e, app);
    if (!el) return;

    const action = el.getAttribute("data-action");
    if (!action) return;

    try {
      switch (action) {
        case "startFlow": {
          const role = el.getAttribute("data-role");
          if (role === "sender" || role === "receiver") void window.startFlow?.(role);
          break;
        }
        case "connectCloud":
          void window.connectCloud?.();
          break;
        case "clearAttachment":
          void window.clearAttachment?.();
          break;
        case "openFilePicker": {
          const input = document.getElementById("hidden-file-input");
          input?.click?.();
          break;
        }
        case "handleSend":
          void window.handleSend?.();
          break;
        case "copyMessage":
          void window.copyMessage?.(el);
          break;
        case "startSend": {
          const id = el.getAttribute("data-file-id");
          if (id) void window.startSend?.(id);
          break;
        }
        case "cancelSend": {
          const id = el.getAttribute("data-file-id");
          if (id) void window.cancelSend?.(id);
          break;
        }
        case "cancelReceive": {
          const id = el.getAttribute("data-file-id");
          if (id) void window.cancelReceive?.(id);
          break;
        }
        case "acceptFile": {
          const id = el.getAttribute("data-file-id");
          if (id) void window.acceptFile?.(id);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error(err);
    }
  },
  true
);

document.addEventListener(
  "input",
  (e) => {
    if (!app) return;
    const target = getEventTargetElement(e);
    if (!target || !app.contains(target)) return;
    if (target.id !== "cloud-code-input") return;

    try {
      window.handleCloudInput?.(target);
    } catch (err) {
      console.error(err);
    }
  },
  true
);

document.addEventListener(
  "keydown",
  (e) => {
    if (!app) return;
    const target = getEventTargetElement(e);
    if (!target || !app.contains(target)) return;
    if (target.id !== "cloud-code-input") return;
    if (e.key !== "Enter") return;

    const btn = document.getElementById("btn-cloud-connect");
    if (btn && !btn.disabled) {
      e.preventDefault();
      void window.connectCloud?.();
    }
  },
  true
);

document.addEventListener(
  "change",
  (e) => {
    if (!app) return;
    const target = getEventTargetElement(e);
    if (!target || !app.contains(target)) return;
    if (target.id !== "hidden-file-input") return;

    try {
      window.handleFileSelect?.(target);
    } catch (err) {
      console.error(err);
    }
  },
  true
);

function formatConnStatus(status) {
  switch (status) {
    case "connected":
      return { text: "● Online (connected)", color: "var(--primary)" };
    case "connecting":
    case "new":
      return { text: "● Connecting…", color: "var(--text-muted)" };
    case "peer-timeout":
      return { text: "● No response (network hiccup?)", color: "#ff9f43" };
    case "disconnected":
    case "failed":
    case "closed":
      return { text: "● Disconnected", color: "#ff6b6b" };
    default:
      return { text: `● ${String(status)}`, color: "var(--text-muted)" };
  }
}

function updateConnStatusUI(status) {
  const { text, color } = formatConnStatus(status);

  const el = document.getElementById("conn-status");
  if (el) {
    el.textContent = text;
    el.style.color = color;
  }

  const badge = document.getElementById("status-badge");
  if (badge) badge.textContent = text.replace(/^●\s*/, "");
}

function formatBitsPerSecond(bitsPerSecond) {
  const n = Number(bitsPerSecond);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let value = n;
  let unitIdx = 0;
  while (value >= 1000 && unitIdx < units.length - 1) {
    value /= 1000;
    unitIdx += 1;
  }
  const digits = unitIdx === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIdx]}`;
}

async function getSelectedCandidatePairStats(pc) {
  if (!pc || typeof pc.getStats !== "function") return null;

  const report = await pc.getStats();
  if (!report) return null;

  let selectedPair = null;
  for (const stat of report.values()) {
    if (stat.type === "transport" && stat.selectedCandidatePairId) {
      selectedPair = report.get(stat.selectedCandidatePairId) || null;
      if (selectedPair) break;
    }
  }

  if (!selectedPair) {
    for (const stat of report.values()) {
      if (stat.type !== "candidate-pair") continue;
      if (stat.selected || stat.nominated) {
        selectedPair = stat;
        break;
      }
    }
  }

  if (!selectedPair) {
    for (const stat of report.values()) {
      if (stat.type === "candidate-pair" && stat.state === "succeeded") {
        selectedPair = stat;
        break;
      }
    }
  }

  if (!selectedPair) return null;

  const local = selectedPair.localCandidateId ? report.get(selectedPair.localCandidateId) : null;
  const remote = selectedPair.remoteCandidateId ? report.get(selectedPair.remoteCandidateId) : null;
  return { pair: selectedPair, local, remote };
}

let connStatsTimer = 0;
let connStatsUpdating = false;

async function updateConnStatsUI() {
  const summaryEl = document.getElementById("conn-summary");
  const statsEl = document.getElementById("conn-stats");
  if (!summaryEl || !statsEl) return;
  const pc = peer?.pc;

  if (!pc) {
    summaryEl.textContent = "Connection details (not connected)";
    statsEl.textContent = "-";
    return;
  }

  if (connStatsUpdating) return;
  connStatsUpdating = true;
  try {
    const s = await getSelectedCandidatePairStats(pc);
    if (!s) {
      summaryEl.textContent = "Connection details (stats unavailable)";
      statsEl.textContent = "-";
      return;
    }

    const localType = String(s.local?.candidateType ?? "-");
    const remoteType = String(s.remote?.candidateType ?? "-");
    const protocol = String(s.local?.protocol ?? s.pair?.protocol ?? "-").toLowerCase();
    const rttMs = Number.isFinite(Number(s.pair?.currentRoundTripTime))
      ? Math.round(Number(s.pair.currentRoundTripTime) * 1000)
      : 0;
    const outBps = Number(s.pair?.availableOutgoingBitrate ?? 0);
    const inBps = Number(s.pair?.availableIncomingBitrate ?? 0);

    const pathShort = `${localType}/${protocol} ↔ ${remoteType}`;
    summaryEl.textContent = `Connection details: ${pathShort}${rttMs ? ` (RTT ${rttMs}ms)` : ""}`;

    const localAddr = String(s.local?.address ?? s.local?.ip ?? "");
    const localPort = s.local?.port ? String(s.local.port) : "";
    const remoteAddr = String(s.remote?.address ?? s.remote?.ip ?? "");
    const remotePort = s.remote?.port ? String(s.remote.port) : "";

    const lines = [];
    lines.push(`Path: ${pathShort}  state=${String(s.pair?.state ?? "-")}`);
    if (localAddr || remoteAddr) {
      lines.push(
        `Local:  ${localAddr}${localPort ? `:${localPort}` : ""}  |  Remote: ${remoteAddr}${remotePort ? `:${remotePort}` : ""}`
      );
    }
    if (rttMs) lines.push(`RTT:   ${rttMs} ms`);
    if (outBps || inBps) {
      const outText = outBps ? formatBitsPerSecond(outBps) : "-";
      const inText = inBps ? formatBitsPerSecond(inBps) : "-";
      lines.push(`BW:    ↑ ${outText}   ↓ ${inText}`);
    }
    lines.push(`STUN:  ${webrtcConfig.useStun ? "on" : "off"}`);
    const striping = Boolean(peer?.remoteCaps?.striping);
    const txCh = webrtcConfig.useFastTransfer && striping ? getFastFileChannelCount() : 1;
    lines.push(`Mode:  Fast=${webrtcConfig.useFastTransfer ? "on" : "off"}   Striping=${striping ? "on" : "off"}   TXch=${txCh}`);
    const lanIp = normalizeLanIpOverride(webrtcConfig.lanIpOverride);
    lines.push(
      `LAN:   ${webrtcConfig.useLanIpOverride ? "on" : "off"}${
        webrtcConfig.useLanIpOverride ? `   IP=${lanIp || "invalid"}` : ""
      }`
    );
    const turnOn = webrtcConfig.useTurn && String(webrtcConfig.turnUrl ?? "").trim();
    lines.push(
      `TURN:  ${turnOn ? "on" : "off"}${turnOn ? `   Relay=${webrtcConfig.forceTurnRelay ? "force" : "auto"}` : ""}`
    );

    const isDirectHost = localType === "host" && remoteType === "host" && protocol === "udp";
    if (!isDirectHost) {
      lines.push("");
      if (protocol === "udp" && localType === "srflx" && remoteType === "srflx") {
        lines.push(
          "Hint: You're on srflx/udp (not a direct LAN path). RTT is usually higher, so very high throughput can be difficult."
        );
        lines.push(
          "      If you're on the same Wi‑Fi: disable guest network/client isolation; or enable LAN IP override; otherwise consider using a LAN TURN relay."
        );
      } else {
        lines.push("Hint: You're not on a direct host/udp path. VPNs, routers, and network policies may affect performance.");
      }
    }

    statsEl.textContent = lines.join("\n");
  } catch (err) {
    summaryEl.textContent = "Connection details (failed to read)";
    statsEl.textContent = `Error: ${err?.message ?? String(err)}`;
  } finally {
    connStatsUpdating = false;
  }
}

function startConnStats() {
  stopConnStats();
  if (!peer?.pc) return;
  void updateConnStatsUI();
  connStatsTimer = setInterval(() => void updateConnStatsUI(), 1000);
}

function stopConnStats() {
  if (connStatsTimer) {
    clearInterval(connStatsTimer);
    connStatsTimer = 0;
  }
  connStatsUpdating = false;
}

function renderFaqSection() {
  const intro = Array.isArray(FAQ_INTRO) ? FAQ_INTRO : [];
  const items = Array.isArray(FAQ_ITEMS) ? FAQ_ITEMS : [];

  const introHtml = intro.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  const itemsHtml = items
    .map((item) => {
      const question = escapeHtml(item?.q ?? "");
      const paragraphs = Array.isArray(item?.a) ? item.a : [];
      const answerHtml = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("");

      return `
        <details class="faq-item">
          <summary>${question}</summary>
          <div class="faq-answer">
            ${answerHtml}
          </div>
        </details>
      `;
    })
    .join("");

  return `
    <section class="faq-section" aria-label="FAQ">
      <h2>FAQ</h2>
      ${introHtml}
      <div class="faq-list">
        ${itemsHtml}
      </div>
    </section>
  `;
}

function renderViewPage(mainCardHtml) {
  return `
    <div class="view-page view-enter">
      <div class="glass-card page-card">
        <div class="page-main">
          ${mainCardHtml}
        </div>
      </div>
      
      <!-- FAQ Section (Outside the card) -->
      ${renderFaqSection()}
    </div>
  `;
}

const Views = {
  // Role Selection
  role: () =>
    renderViewPage(`
    <section>
      <div class="role-grid">
        <button type="button" class="role-card" data-action="startFlow" data-role="sender">
          <div class="role-icon">📤</div>
          <div class="role-label">I'm sending</div>
        </button>
        <button type="button" class="role-card" data-action="startFlow" data-role="receiver">
          <div class="role-icon">📥</div>
          <div class="role-label">I'm receiving</div>
        </button>
      </div>
    </section>
  `),

  // Connection Steps (Cloud Only)
  connect: (data) =>
    renderViewPage(`
    <section>
      <h2 id="step-title">${data.title}</h2>
      <p id="step-desc">${data.desc}</p>
      
      <!-- CLOUD MODE UI -->
      <div id="mode-cloud" style="display:block">
        ${!data.isConfigured ? `
           <div class="inline-alert" role="note" aria-label="Setup required">
             <h3>⚠️ Backend not configured</h3>
             <p style="font-size:13px; margin:0">Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_KEY</code> in <code>.env</code> to enable signaling.</p>
           </div>
        ` : ''}

        ${data.isConfigured ? `
           ${data.isSender ? `
              <div class="code-display">
                <span class="code-digit">${data.cloudCode ? data.cloudCode.slice(0,3) : '...'}</span>
                <span class="code-sep">-</span>
                <span class="code-digit">${data.cloudCode ? data.cloudCode.slice(3) : '...'}</span>
              </div>
              <p style="text-align:center; font-size:13px; color:var(--text-muted); margin-top:8px">Ask the receiver to enter this 6-digit code</p>
              <div style="text-align:center; margin-top:16px; min-height:20px" id="cloud-status">Waiting for the receiver to join...</div>
	           ` : `
	              <div class="code-input-container">
	                 <input type="tel" id="cloud-code-input" class="code-input" placeholder="Enter the 6-digit code" maxlength="6" autocomplete="off">
	                 <button type="button" class="btn btn-primary" id="btn-cloud-connect" data-action="connectCloud" disabled>Connect</button>
	              </div>
	              <p style="text-align:center; font-size:13px; color:var(--text-muted); margin-top:8px">Enter the code shown on the sender’s screen</p>
	           `}
	        ` : ''}
      </div>

      <div style="margin-top:24px; text-align:left; font-size:12px; color:var(--text-muted); border-top:1px solid var(--glass-border); padding-top:12px">
        Status: <span id="status-badge">Waiting...</span>
      </div>
    </section>
  `),

  // 4. Transfer Interface
	  transfer: () =>
      renderViewPage(`
	    <section>
	      <div class="transfer-header">
	        <h2>Send &amp; Receive</h2>
	        <div id="conn-status" style="color:var(--text-muted); font-size:14px">● Connecting…</div>
	      </div>

              <div class="transfer-container">
		      <div class="transfer-list" id="transfer-list">
		        <!-- Files/Text go here -->
		      </div>
              
              <div class="transfer-divider"></div>

       <!-- Combined Input Area -->
       <div id="transfer-input-area">
          <!-- Attachment Preview -->
           <div id="attachment-preview" style="display:none; margin-bottom: 12px; padding: 8px; background: var(--surface-muted); border: 1px solid var(--glass-border); border-radius: 8px; align-items: center; justify-content: space-between;">
              <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
                  <span style="font-size:20px">📄</span>
                  <span id="attachment-name" style="font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis"></span>
              </div>
              <button type="button" data-action="clearAttachment" style="background:none; border:none; color: var(--error); cursor: pointer; padding:4px 8px; font-size:16px">✕</button>
           </div>

           <textarea id="msg-input" class="chat-input" placeholder="Type a message..."></textarea>
           
           <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px;">
              <div>
                  <button type="button" class="btn" style="width: auto; padding: 8px 16px; font-size: 13px;" data-action="openFilePicker">📂 Choose file</button>
                  <span id="file-count-label" style="font-size:12px; color:var(--text-muted); margin-left:8px; display:none"></span>
              </div>
              <input type="file" id="hidden-file-input" style="display:none">
              
              <button type="button" class="btn btn-primary" style="width: auto; padding: 8px 24px" data-action="handleSend">Send</button>
           </div>
       </div>
       </div>
    </section>
  `)
};

// --- Main Logic ---
// --- Router & Navigation ---
let transitionTimer = null;
let currentView = null;

function viewHtmlToElement(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html).trim();
  const el = tpl.content.firstElementChild;
  if (!el) throw new Error("View rendered empty HTML");
  return el;
}

function nextPaint() {
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
  return new Promise((resolve) => raf(() => resolve()));
}

async function afterPaint(frames = 1) {
  const count = Math.max(1, Number(frames) || 1);
  for (let i = 0; i < count; i++) await nextPaint();
}

function scheduleEnterCleanup(el) {
  if (!el) return;
  const cleanup = () => {
    try { el.classList.remove("view-enter"); } catch {}
  };

  el.addEventListener(
    "animationend",
    (e) => {
      if (e.target === el) cleanup();
    },
    { once: true }
  );
  setTimeout(cleanup, 500);
}

window.router = (viewName, data = {}) => {
  if (!app) return;

  if (transitionTimer) {
    clearTimeout(transitionTimer);
    transitionTimer = null;
  }

  // Avoid duplicate IDs during transitions of the same view.
  if (currentView === viewName) {
    try {
      app.innerHTML = Views[viewName](data);
      const root = app.firstElementChild;
      scheduleEnterCleanup(root);
      void nextPaint().then(() => {
        try { initViewHandlers(viewName, data); } catch (err) { console.error(err); }
        try { flushUiOps(); } catch (err) { console.error(err); }
      });
    } catch (err) {
      console.error(err);
      app.textContent = "";
      const card = document.createElement("div");
      card.className = "glass-card view-enter";
      const title = document.createElement("h2");
      title.textContent = "Failed to render";
      const p = document.createElement("p");
      p.style.textAlign = "left";
      p.style.whiteSpace = "pre-wrap";
      p.textContent = err?.stack || String(err);
      const btn = document.createElement("button");
      btn.className = "btn btn-primary";
      btn.textContent = "Reload";
      btn.onclick = () => location.reload();
      card.append(title, p, btn);
      app.appendChild(card);
      currentView = "error";
    }
    return;
  }

  const oldEls = Array.from(app.children);
  oldEls.forEach((el) => el.classList.add("view-exit"));

  try {
    const nextEl = viewHtmlToElement(Views[viewName](data));
    app.appendChild(nextEl);
    scheduleEnterCleanup(nextEl);
    currentView = viewName;
    void nextPaint().then(() => {
      try { initViewHandlers(viewName, data); } catch (err) { console.error(err); }
      try { flushUiOps(); } catch (err) { console.error(err); }
    });
  } catch (err) {
    console.error(err);
    app.textContent = "";

    const card = document.createElement("div");
    card.className = "glass-card view-enter";

    const title = document.createElement("h2");
    title.textContent = "Failed to render";

    const p = document.createElement("p");
    p.style.textAlign = "left";
    p.style.whiteSpace = "pre-wrap";
    p.textContent = err?.stack || String(err);

    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.textContent = "Reload";
    btn.onclick = () => location.reload();

    card.append(title, p, btn);
    app.appendChild(card);
    currentView = "error";
  }

  const reduceEffects = document.documentElement.classList.contains("reduce-effects");
  const delay = reduceEffects ? 0 : (oldEls.length ? 300 : 0);
  transitionTimer = setTimeout(() => {
    oldEls.forEach((el) => {
      if (el.parentNode === app) el.remove();
    });
  }, delay);
};

window.startFlow = async (role) => {
  const myGen = ++flowGeneration;
  currentRole = role;
  try { peer?.close?.(); } catch {}
  peer = new PeerClient(onPeerStatus, onPeerData);
  currentOfferSignal = "";
  
  if (role === 'sender') {
    // Sender flow
    const cloudCode = generateRoomCode();
    currentCloudRoomCode = cloudCode;

    router('connect', { 
      title: "Connecting",
      desc: "Your code is ready",
      isSender: true,
      cloudCode,
      isConfigured: isSupabaseConfigured()
    });

    // Initialize Cloud Signaling
    setupSenderSignaling();
    
    // Auto-confirm logic is handled by signaling/WebRTC directly now.
    // Legacy manualInputCallback is removed as we depend on Cloud Signaling.

    // Let the view render & animations start before doing heavy WebRTC work.
    await afterPaint(2);
    if (flowGeneration !== myGen) return;
    
    try {
      const code = await peer.createOffer();
      if (flowGeneration !== myGen) return;
      
      // Store for cloud signaling
      currentOfferSignal = code;
      trySendOfferSignal(); // Try sending immediately if joined

      // Safe update
      if(currentRole === 'sender') {
          // No UI update needed for code display, as cloud connection handles it.
          // We just wait for WebRTC 'connected' state.
      }
    } catch(e) { console.error(e); }

  } else {
    currentCloudRoomCode = "";
    // Receiver flow
    router('connect', {
      title: "Connecting",
      desc: "Enter the code to connect",
      isSender: false,
      isConfigured: isSupabaseConfigured()
    });
    
    // Receiver waits for user input to connect cloud
    // Logic handled by connectCloud() -> setupSignalingHandlers()

    // Legacy handleOffer/manualInputCallback removed.
    await afterPaint(2);
  }
};

// --- Global State for Input ---
let pendingAttachment = null;

window.handleFileSelect = (input) => {
    if (input.files && input.files[0]) {
        pendingAttachment = input.files[0];
        
        // Update Preview
        const preview = document.getElementById('attachment-preview');
        const nameEl = document.getElementById('attachment-name');
        if (preview && nameEl) {
            preview.style.display = 'flex';
            nameEl.textContent = pendingAttachment.name;
        }
        
        // Reset input so same file selection triggers change again if needed
        input.value = ''; 
    }
};

window.clearAttachment = () => {
    pendingAttachment = null;
    const preview = document.getElementById('attachment-preview');
    if (preview) preview.style.display = 'none';
};

window.handleSend = async () => {
    const textEl = document.getElementById('msg-input');
    const text = textEl ? textEl.value.trim() : '';
    const hadAttachment = Boolean(pendingAttachment);
    const isConnected = peer?.dc?.readyState === "open";

    // 1. Send Text if exists
    if (text) {
        if (!isConnected) {
            alert("Not connected yet. Can't send a message.");
        } else {
            peer.send(JSON.stringify({ type: 'text', text }));
            addTextItem(text, 'sent');
            textEl.value = '';
        }
    }

    // 2. Send File if exists
    if (pendingAttachment) {
        const file = pendingAttachment;
        const id = Math.random().toString(36).slice(2);
        
        stagedFiles.set(id, file);
        
        // If not connected yet, stage it and let user send later.
        addFileItem(id, file.name, file.size, isConnected ? 'sending' : 'pending-send');
        clearAttachment();

        if (isConnected) {
            // Trigger send (async; don't block UI)
            void startSend(id);
        }
    }
    
    if (!text && !hadAttachment) {
       // Optional: Shake animation or visual feedback for empty send
    }
};

window.copyMessage = async (btn) => {
  const bubble = btn?.parentElement?.querySelector?.(".msg-bubble");
  const text = bubble?.textContent ?? "";
  if (!text) return;

  const old = btn.textContent;
  try {
    await copyToClipboard(text);
    btn.textContent = "Copied";
    setTimeout(() => {
      if (btn.isConnected) btn.textContent = old;
    }, 1500);
  } catch (err) {
    console.error(err);
    alert("Copy failed.");
  }
};

function onPeerStatus(status) {
  updateConnStatusUI(status);
  
  if (status === "disconnected" || status === "failed" || status === "closed") {
    stopConnStats();
    fileAcceptEarly.clear();
    for (const [id, waiter] of fileAcceptWaiters) {
      try { waiter.reject(new Error("Connection lost")); } catch {}
      fileAcceptWaiters.delete(id);
    }
    for (const [id, waiter] of fileDoneWaiters) {
      try { waiter.reject(new Error("Connection lost")); } catch {}
      fileDoneWaiters.delete(id);
    }
    for (const [id, state] of outgoingTransfers) {
      try { state.controller.abort(createAbortError("Connection lost")); } catch {}
      updateFileItemStatus(id, "Connection lost");
      outgoingTransfers.delete(id);
    }
    const r = peer?.receiving;
    if (r?.id) cancelIncomingFile(r.id, { notifyPeer: false, reason: "Connection lost" });
    for (const id of Array.from(incomingFiles.keys())) {
      cancelIncomingFile(id, { notifyPeer: false, reason: "Connection lost" });
    }
  }

  if(status === 'connected') {
    if(document.getElementById('step-title')) {
      router('transfer');
    }
  }
}

const stagedFiles = new Map(); // id -> File
const receivedFiles = new Map(); // id -> { chunks, name }
const incomingFiles = new Map(); // id -> { id, name, size, received, chunks, writer, writeQueue, writePromise }
const pendingUiOps = [];
const progressFillCache = new Map(); // id -> HTMLElement
const progressPending = new Map(); // id -> number
let progressFlushHandle = 0;

function getDeviceMemoryGB() {
  const mem = Number(navigator?.deviceMemory || 0);
  return Number.isFinite(mem) && mem > 0 ? mem : 0;
}

const WRITE_BATCH_BYTES = (() => {
  const mem = getDeviceMemoryGB();
  if (mem >= 8) return 16 * 1024 * 1024; // 16MB
  if (mem >= 4) return 8 * 1024 * 1024; // 8MB
  return 4 * 1024 * 1024; // 4MB
})();

function flushFileWrites(state) {
  if (!state?.writer) return Promise.resolve();
  if (state.writePromise) return state.writePromise;
  if (!Number.isInteger(state.writeQueueStart) || state.writeQueueStart < 0) state.writeQueueStart = 0;

  state.writePromise = (async () => {
    let inFlight = null;
    try {
      const batchLimit = webrtcConfig.useFastTransfer ? WRITE_BATCH_BYTES * 2 : WRITE_BATCH_BYTES;
      while (state.writer && state.writeQueueStart < state.writeQueue.length) {
        let batchBytes = 0;
        const items = [];

        while (state.writeQueueStart < state.writeQueue.length && batchBytes < batchLimit) {
          const item = state.writeQueue[state.writeQueueStart++];
          if (!item) continue;
          items.push(item);
          batchBytes += item.bytes || 0;
        }

        if (!items.length) break;
        inFlight = items;

        const parts = items.map((it) => it.data);
        const dataToWrite = parts.length === 1 ? parts[0] : new Blob(parts);
        await state.writer.write(dataToWrite);
        state.writeQueuedBytes = Math.max(0, state.writeQueuedBytes - batchBytes);

        inFlight = null;

        // Avoid unbounded array growth and O(n²) shift cost by compacting occasionally.
        if (state.writeQueueStart > 4096 && state.writeQueueStart > state.writeQueue.length / 2) {
          state.writeQueue = state.writeQueue.slice(state.writeQueueStart);
          state.writeQueueStart = 0;
        }
      }
    } catch (err) {
      console.error(err);
      const message = err?.message ?? String(err);
      alert(`Failed to write file: ${message}`);
      try { cancelIncomingFile(state.id, { notifyPeer: true, reason: "Failed to write file" }); } catch (e) { console.error(e); }
    } finally {
      state.writePromise = null;
      if (state.writer && state.writeQueueStart < state.writeQueue.length) {
        void flushFileWrites(state);
      }
    }
  })();

  return state.writePromise;
}

function getProgressFillEl(id) {
  const cached = progressFillCache.get(id);
  if (cached?.isConnected) return cached;

  const el = document.querySelector(`#file-${id} .progress-fill`);
  if (el) progressFillCache.set(id, el);
  return el;
}

function scheduleProgressFlush() {
  if (progressFlushHandle) return;
  const schedule =
    typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(cb, 16);

  progressFlushHandle = schedule(() => {
    progressFlushHandle = 0;
    for (const [id, percent] of progressPending) {
      progressPending.delete(id);
      const bar = getProgressFillEl(id);
      if (bar) bar.style.transform = `scaleX(${percent})`;
    }
  });
}

function escapeHtml(input) {
  return String(input).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

function enqueueUiOp(op) {
  const list = document.getElementById("transfer-list");
  if (list) {
    try {
      op();
    } catch (err) {
      console.error(err);
    }
    return;
  }

  pendingUiOps.push(op);
  if (currentRole && currentView !== "transfer") {
    router("transfer");
  }
}

function flushUiOps() {
  const list = document.getElementById("transfer-list");
  if (!list) return;

  while (pendingUiOps.length) {
    const op = pendingUiOps.shift();
    try {
      op();
    } catch (err) {
      console.error(err);
    }
  }
}

window.acceptFile = async (id) => {
  const fileId = String(id ?? "").trim();
  if (!fileId) return;
  const state = incomingFiles.get(fileId);
  if (!state) return;

  if (state.accepted) return;

  if (!state.writer) {
    if (typeof window.showSaveFilePicker !== "function") {
      alert(
        "This browser doesn't support choosing a save location and writing the file directly.\n\nUse desktop Chrome/Edge as the receiver."
      );
      return;
    }

    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: state.name || "download",
      });
      state.writer = await handle.createWritable();
      state.chunks = null;
    } catch (err) {
      if (err?.name === "AbortError") return;
      console.error(err);
      alert(`Couldn't create the save file: ${err?.message ?? String(err)}`);
      return;
    }
  }

  const sendAccept = () => {
    if (!peer?.dc || peer.dc.readyState !== "open") return false;
    try {
      peer.send(JSON.stringify({ type: "file-accept", id: fileId }));
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  };

  // User clicked "Accept"
  // 1) Notify sender (with a short resend loop for robustness)
  const ok = sendAccept();
  if (!ok) {
    alert("Not connected yet. Can't confirm receipt.");
    return;
  }

  state.accepted = true;
  state.acceptAcked = false;
  state.startedAt = nowMs();
  state.speedLastAt = state.startedAt;
  state.speedLastBytes = 0;

  if (state.acceptResendTimer) {
    try { clearInterval(state.acceptResendTimer); } catch {}
    state.acceptResendTimer = 0;
  }
  state.acceptResendAttempts = 0;
  const acceptTimer = setInterval(() => {
    const s = incomingFiles.get(fileId);
    if (!s || s.cancelled) {
      try { clearInterval(acceptTimer); } catch {}
      if (s) s.acceptResendTimer = 0;
      return;
    }
    if (s.acceptAcked || !s.accepted) {
      try { clearInterval(acceptTimer); } catch {}
      s.acceptResendTimer = 0;
      return;
    }
    s.acceptResendAttempts = (s.acceptResendAttempts || 0) + 1;
    if (s.acceptResendAttempts > 20) {
      try { clearInterval(acceptTimer); } catch {}
      s.acceptResendTimer = 0;
      updateFileItemStatus(fileId, "Accepted, but the sender isn't responding (try reconnecting).");
      return;
    }
    sendAccept();
  }, 700);
  state.acceptResendTimer = acceptTimer;
  
  // 2. Update UI
  const el = document.getElementById(`file-${fileId}`);
  if(el) {
     const btn = el.querySelector('.btn-accept');
     if(btn) btn.remove();
     
     const status = el.querySelector('.file-status-text');
     if(status) status.textContent = "Accepted. Waiting for the sender to start...";
     
     const progressBar = el.querySelector('.progress-bar');
     if(progressBar) progressBar.style.display = 'block';
  }
};

async function onPeerData(msg) {
  if (msg.type === 'text') {
    addTextItem(String(msg.text ?? ''), 'received');
  } else if (msg.type === 'file-accept') {
    // Sender received acceptance
    const id = String(msg.id ?? "").trim();
    if (!id) return;
    resolveFileAccept(id);
    try { peer.send(JSON.stringify({ type: "file-accept-ack", id })); } catch {}

  } else if (msg.type === 'file-accept-ack') {
    const id = String(msg.id ?? "").trim();
    if (!id) return;
    const state = incomingFiles.get(id);
    if (state) {
      state.acceptAcked = true;
      if (state.acceptResendTimer) {
        try { clearInterval(state.acceptResendTimer); } catch {}
        state.acceptResendTimer = 0;
      }
    }

  } else if (msg.type === 'file-done') {
    const id = String(msg.id ?? "").trim();
    if (!id) return;
    resolveFileDone(id);

  } else if (msg.type === 'file-meta') {
    if (peer?.receiving) return;

    const id = String(msg.id ?? "").trim();
    const name = String(msg.name ?? "download");
    const size = Number(msg.size);
    if (!id || !Number.isFinite(size) || size < 0) return;

    addFileItem(id, name, size, 'receiving-large');
    
    const state = {
      id,
      streamId: String(msg.sid ?? "").trim(),
      streamCount: Math.max(1, Math.floor(Number(msg.sc) || 0) || 1),
      name,
      size,
      startedAt: 0,
      speedLastAt: 0,
      speedLastBytes: 0,
      acceptAcked: false,
      acceptResendTimer: 0,
      acceptResendAttempts: 0,
      received: 0,
      lastUiUpdateAt: 0,
      expectedSeq: 0,
      pendingChunks: new Map(),
      needsAccept: true,
      accepted: false,
      cancelled: false,
      chunks: null,
      writer: null,
      writeQueue: [],
      writeQueueStart: 0,
      writeQueuedBytes: 0,
      writePromise: null,
    };
    incomingFiles.set(id, state);
    peer.receiving = state;
    
    // Wait for user confirmation and save location selection before receiving.

  } else if (msg.type === 'file-cancel') {
    const id = String(msg.id ?? "").trim();
    if (!id) return;
    const reason =
      String(msg.reason ?? "Canceled by the other side").trim() || "Canceled by the other side";
    cancelOutgoingFile(id, { notifyPeer: false, reason });
    cancelIncomingFile(id, { notifyPeer: false, reason });

  } else if (msg.type === 'file-channel-closed') {
    const streamId = String(msg.streamId ?? "").trim();
    const r = peer?.receiving;
    if (r && streamId && r.streamId && streamIdMatchesBase(r.streamId, streamId)) {
      // Only abort immediately if the base channel closes; extra channels may be optional.
      if (streamId === r.streamId) {
        cancelIncomingFile(r.id, { notifyPeer: false, reason: "File channel closed" });
      }
    }

  } else if (msg.type === 'file-chunk') {
    const r = peer.receiving;
    if(!r) return;
    if (r.cancelled) return;
    if (r.needsAccept && !r.accepted) return;
    if (r.accepted && !r.writer) {
      cancelIncomingFile(r.id, { notifyPeer: true, reason: "Couldn't create the save file" });
      return;
    }
    if (!r.acceptAcked) {
      r.acceptAcked = true;
      if (r.acceptResendTimer) {
        try { clearInterval(r.acceptResendTimer); } catch {}
        r.acceptResendTimer = 0;
      }
    }

    const streamId = String(msg.streamId ?? "").trim();
    if (r.streamId && streamId && !streamIdMatchesBase(r.streamId, streamId)) return;

    const seq = Number(msg.seq);
    if (!Number.isFinite(seq) || seq < 0 || !Number.isInteger(seq)) return;

    const chunk = msg.data;
    const bytes = getBinaryByteLength(chunk);
    if (bytes < 0) return;

    const commitChunk = (data) => {
      const chunkBytes = getBinaryByteLength(data);
      if (chunkBytes <= 0) return;
      if (r.writer) {
        r.writeQueue.push({ data, bytes: chunkBytes });
        r.writeQueuedBytes += chunkBytes;
        void flushFileWrites(r);
      } else if (r.chunks) {
        r.chunks.push(data);
      }
      r.received += chunkBytes;
    };

    if (seq < r.expectedSeq) return; // duplicate/late
    if (seq > r.expectedSeq) {
      if (!r.pendingChunks.has(seq)) r.pendingChunks.set(seq, chunk);
      return;
    }

    commitChunk(chunk);
    r.expectedSeq += 1;
    while (r.pendingChunks.has(r.expectedSeq)) {
      const next = r.pendingChunks.get(r.expectedSeq);
      r.pendingChunks.delete(r.expectedSeq);
      commitChunk(next);
      r.expectedSeq += 1;
    }

    const now = nowMs();
    if (!r.lastUiUpdateAt || now - r.lastUiUpdateAt >= UI_PROGRESS_MIN_INTERVAL_MS || r.received >= r.size) {
      updateProgress(r.id, r.size === 0 ? 1 : r.received / r.size);
      if (r.writer && r.accepted) {
        const dt = now - (r.speedLastAt || 0);
        if (dt >= 400) {
          const delta = Math.max(0, r.received - (r.speedLastBytes || 0));
          const bps = dt > 0 ? (delta * 1000) / dt : 0;
          r.speedLastAt = now;
          r.speedLastBytes = r.received;
          enqueueUiOp(() => updateFileItemStatus(r.id, `Receiving... ${formatBytes(bps)}/s`));
        }
      }
      r.lastUiUpdateAt = now;
    }
    
    if (r.received >= r.size) {
      if (r.writer) {
        await flushFileWrites(r);
        try { await r.writer?.close(); } catch (err) { console.error(err); }
      }

      if (!r.writer) {
        // Transfer complete, store explicitly for manual download
        receivedFiles.set(r.id, {
          chunks: r.chunks ?? [],
          name: r.name ?? 'download'
        });
      }

      try { peer.send(JSON.stringify({ type: "file-done", id: r.id })); } catch {}

      peer.receiving = null;
      
      // UI update: Show Download Button
      enqueueUiOp(() => {
        const el = document.getElementById(`file-${r.id}`);
        if(!el) return;

	        updateProgress(r.id, 1);

	        const status = el.querySelector('.file-status-text');
	        if(status) status.remove(); // Remove "Receiving..."
	        el.querySelector('.btn-cancel')?.remove();
	        el.querySelector('.btn-accept')?.remove();

	        if (!incomingFiles.has(r.id)) return;
        const state = incomingFiles.get(r.id);
        incomingFiles.delete(r.id);

        if (state?.writer) {
          const done = document.createElement("div");
          done.className = "file-status-text";
          done.textContent = "✅ Saved";
          el.querySelector(".file-info")?.appendChild(done);
          return;
        }

        // Add Download Button
        if (!el.querySelector('.btn-download')) {
          const btn = document.createElement('button');
          btn.className = 'btn btn-primary btn-download';
          btn.style.cssText = 'padding:4px 12px; font-size:12px; width:auto; margin-top:4px';
          btn.textContent = "📥 Save file";
          btn.onclick = () => downloadFile(r.id);
          el.querySelector('.file-info')?.appendChild(btn);
        }
      });
    }
  }
}

function addTextItem(text, type) {
  enqueueUiOp(() => {
    const list = document.getElementById('transfer-list');
    if (!list) return;

    const div = document.createElement('div');
    const isSent = type === 'sent';
    div.className = `file-item ${isSent ? 'sent' : 'received'}`;
    
    const copyBtnStyle = isSent 
       ? "margin-top:6px; padding:4px 10px; font-size:12px; width:auto; background:var(--surface-strong); color:var(--text-main); border:1px solid var(--glass-border)"
       : "margin-top:6px; padding:4px 10px; font-size:12px; width:auto; background:var(--surface-muted); color:var(--text-main); border:1px solid var(--glass-border)";

	    div.innerHTML = `
	      <div style="font-size:24px; margin-top:2px">${isSent?'📤':'💬'}</div>
	      <div class="file-info">
	        <div class="msg-bubble">${escapeHtml(text)}</div>
	        <div class="file-meta" style="margin-top:4px; text-align:${isSent?'right':'left'}">${new Date().toLocaleTimeString()}</div>
	        <button type="button" class="btn" style="${copyBtnStyle}" data-action="copyMessage">Copy</button>
	      </div>
	    `;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  });
}

function initViewHandlers(view, data) {
  if (view === "connect") {
    // Cloud-only connect page: focus input for receiver.
    if (!data?.isSender) {
      const input = document.getElementById("cloud-code-input");
      try { input?.focus?.(); } catch {}
    }
    return;
  }

  if (view === "transfer") {
    const status =
      peer?.dc?.readyState === "open"
        ? "connected"
        : (peer?.pc?.connectionState || "connecting");
    updateConnStatusUI(status);
  }
}

// --- UI Helpers ---
function addFileItem(id, name, size, type) {
  enqueueUiOp(() => {
    const list = document.getElementById('transfer-list');
    if (!list) return;

    document.getElementById(`file-${id}`)?.remove();

    const div = document.createElement('div');
    const isSent = type.includes('send'); // 'pending-send', 'sending'
    div.className = `file-item ${isSent ? 'sent' : 'received'}`;
    div.id = `file-${id}`;
    
	    let actionBtn = '';
	    let statusText = '';
	    let progressBarDisplay = 'none';
	    
	    // Compact action button styles for file rows.
	    const btnStyle = "padding:4px 12px; font-size:12px; width:auto; margin-top:4px;";
	    const cancelBtnStyle = "padding:4px 12px; font-size:12px; width:auto; margin-top:4px; background:var(--surface-muted); border:1px solid var(--glass-border); color:var(--text-main); box-shadow:none";
	    const actionRowStyle = `display:flex; gap:8px; margin-top:4px; justify-content:${isSent ? "flex-end" : "flex-start"}; flex-wrap:wrap;`;

		    if (type === 'pending-send') {
		       actionBtn = `
		         <div style="${actionRowStyle}">
		           <button type="button" class="btn btn-primary btn-action" style="${btnStyle}" data-action="startSend" data-file-id="${id}">Send now</button>
		           <button type="button" class="btn btn-cancel" style="${cancelBtnStyle}" data-action="cancelSend" data-file-id="${id}">Cancel</button>
		         </div>
		       `;
		    } else if (type === 'receiving') {
		       statusText = '<div class="file-status-text">Ready to receive...</div>';
		       progressBarDisplay = 'block';
		       actionBtn = `
		         <div style="${actionRowStyle}">
		           <button type="button" class="btn btn-cancel" style="${cancelBtnStyle}" data-action="cancelReceive" data-file-id="${id}">Cancel</button>
		         </div>
		       `;
		    } else if (type === 'receiving-large') {
		       statusText = '<div class="file-status-text">Waiting for you to accept...</div>';
		       const acceptBtnStyle = "padding:4px 12px; font-size:12px; width:auto; margin-top:4px; background:var(--primary); border:none; color:#fff";
		       actionBtn = `
		         <div style="${actionRowStyle}">
		           <button type="button" class="btn btn-primary btn-accept" style="${acceptBtnStyle}" data-action="acceptFile" data-file-id="${id}">Accept</button>
		           <button type="button" class="btn btn-cancel" style="${cancelBtnStyle}" data-action="cancelReceive" data-file-id="${id}">Cancel</button>
		         </div>
		       `;
		       progressBarDisplay = 'none';
		    } else if (type === 'sending') {
		       statusText = '<div class="file-status-text">Sending...</div>';
		       progressBarDisplay = 'block';
		       actionBtn = `
		         <div style="${actionRowStyle}">
		           <button type="button" class="btn btn-cancel" style="${cancelBtnStyle}" data-action="cancelSend" data-file-id="${id}">Cancel</button>
		         </div>
		       `;
		    }

    const sizeText = formatBytes(size);

    div.innerHTML = `
      <div style="font-size:24px">${isSent?'📤':'📥'}</div>
      <div class="file-info">
        <div class="file-name">${escapeHtml(name)}</div>
        <div class="file-meta" style="text-align:${isSent?'right':'left'}">${sizeText}</div>
        ${statusText}
        ${actionBtn}
        <div class="progress-bar" style="display:${progressBarDisplay}; background:var(--surface-strong)"><div class="progress-fill" style="background:${isSent ? 'var(--primary)' : 'var(--success)'}"></div></div>
      </div>
    `;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  });
}

function updateProgress(id, percent) {
  const clamped = Math.max(0, Math.min(1, Number(percent) || 0));
  progressPending.set(id, clamped);
  scheduleProgressFlush();
}

function downloadFile(id) {
  const fileData = receivedFiles.get(id);
  if(!fileData) return;

  const blob = new Blob(fileData.chunks);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileData.name;
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    receivedFiles.delete(id);
  }, 60_000);
}

function enableReducedEffectsIfNeeded() {
  const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cores = Number(navigator.hardwareConcurrency || 0);
  const mem = Number(navigator.deviceMemory || 0);

  if (reduceMotion || (cores && cores <= 4) || (mem && mem <= 4)) {
    document.documentElement.classList.add("reduce-effects");
  }
}

// --- Cloud Signaling Helpers ---
let currentCloudRoomCode = "";
let currentOfferSignal = "";


function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

window.handleCloudInput = (el) => {
  const val = el.value.replace(/[^0-9]/g, '').slice(0, 6);
  el.value = val;
  const btn = document.getElementById('btn-cloud-connect');
  if (btn) btn.disabled = val.length !== 6;
};

window.connectCloud = async () => {
  const input = document.getElementById('cloud-code-input');
  const code = input?.value;
  if (!code || code.length !== 6) return;

  if (!isSupabaseConfigured()) {
    alert("Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_KEY in .env.");
    return;
  }
  
  const btn = document.getElementById('btn-cloud-connect');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Connecting...";
  }

  try {
    setupSignalingHandlers(false); // Receiver
    signaling.onOpen = () => {
        const sendJoin = () => signaling.send(JSON.stringify({ type: 'join' }));
        sendJoin();
        // Retry join every 3s until we receive a signal or close
        if (signaling.joinTimer) clearInterval(signaling.joinTimer);
        signaling.joinTimer = setInterval(() => {
            if (!signaling.isConnected) return clearInterval(signaling.joinTimer);
            console.log("Retrying join...");
            sendJoin();
        }, 3000);
    };
    signaling.onError = (err) => {
       alert(`Connection failed: ${err.message}\nCheck console logs, network, and Supabase config.`);
       if (btn) {
         btn.disabled = false;
         btn.textContent = "Connect";
       }
    };
    if (signaling.joinTimer) {
      clearInterval(signaling.joinTimer);
      signaling.joinTimer = null;
    }
    signaling.connect(code);
  } catch (err) {
    console.error(err);
    alert("Failed to connect to the signaling service.");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Connect";
    }
  }
};

function trySendOfferSignal() {
  if (!currentOfferSignal) return;
  if (!signaling?.isConnected) return;

  try {
    signaling.send(JSON.stringify({ type: 'signal', content: currentOfferSignal }));
    // hasSentOfferSignal = true; // Allow resending if requested by join
    const statusEl = document.getElementById('cloud-status');
    if (statusEl) statusEl.textContent = "Establishing P2P connection...";
  } catch (err) {
    console.error(err);
  }
}

function setupSenderSignaling() {
  const code = currentCloudRoomCode;
  if (!code) return;
  
  setupSignalingHandlers(true); // Sender
  
  const statusEl = document.getElementById('cloud-status');
  if (statusEl) statusEl.textContent = "Connecting to signaling...";
  
  signaling.onOpen = () => {
      if (statusEl) statusEl.textContent = "Connected to signaling. Waiting for the other side...";
      trySendOfferSignal();
  };
  signaling.onError = (err) => {
      if (statusEl) statusEl.textContent = `Connection error: ${err.message}. (Try reloading?)`;
  };
  if (signaling.joinTimer) {
    clearInterval(signaling.joinTimer);
    signaling.joinTimer = null;
  }
  signaling.connect(code);
}

function setupSignalingHandlers(isSender) {
  let lastOffer = "";
  let lastAnswer = "";

  signaling.onMessage = async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    
    if (msg.type === 'signal') {
      const signalCode = msg.content;
      if (!signalCode || !peer) return;

      let decoded;
      try {
        decoded = await peer.decodeSignal(signalCode);
      } catch (e) {
        console.error(e);
        return;
      }

      const signalType = decoded?.type;
      if (isSender) {
        // Sender only accepts Answer; ignore Offer/others (including loopback).
        if (signalType !== "answer") return;
        if (signalCode === lastAnswer) return;
        lastAnswer = signalCode;

        if (signaling.joinTimer) {
          clearInterval(signaling.joinTimer);
          signaling.joinTimer = null;
        }
        try {
          const statusEl = document.getElementById('cloud-status');
          if (statusEl) statusEl.textContent = "Establishing P2P connection...";
          await peer.applyAnswer(signalCode);
        } catch (e) {
          console.error(e);
        }
        return;
      }

      // Receiver only accepts Offer; ignore Answer/others (including loopback).
      if (signalType !== "offer") return;
      if (signalCode === lastOffer) return;
      lastOffer = signalCode;

      if (signaling.joinTimer) { // Stop retrying join once we actually get an offer
        clearInterval(signaling.joinTimer);
        signaling.joinTimer = null;
      }

      try {
        const answer = await peer.createAnswer(signalCode);
        signaling.send(JSON.stringify({ type: 'signal', content: answer }));
      } catch (e) {
        console.error(e);
      }
    } else if (msg.type === 'join') {
        // Receiver joined. Sender sends offer.
        if (isSender) {
             const statusEl = document.getElementById('cloud-status');
             if (statusEl) statusEl.textContent = "Peer joined. Sending connection request...";
             trySendOfferSignal();
        }
    }
  };
}

// Init
enableReducedEffectsIfNeeded();
window.addEventListener("beforeunload", () => {
  try { peer?.close?.(); } catch {}
});
router('role');
