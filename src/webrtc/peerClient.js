// Core WebRTC utilities, configuration, and the PeerClient implementation.

// --- Signal Prefixes ---
const SIGNAL_PREFIX_GZIP = "SHR1:";
const SIGNAL_PREFIX_RAW = "SHR0:";
const SIGNAL_PREFIX_GZIP_B32 = "SHR2:";
const SIGNAL_PREFIX_RAW_B32 = "SHR3:";

// --- Operational Constants ---
const FILE_CHUNK_SIZE = 256 * 1024; // 256KB
const UI_PROGRESS_MIN_INTERVAL_MS = 80;
const HEARTBEAT_INTERVAL_MS = 1200;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const CTRL_CHANNEL_LABEL = "sharefile-ctrl";
const FILE_CHANNEL_LABEL_PREFIX = "sharefile-file:";
const FILE_FRAME_HEADER_BYTES = 8; // seq(u32) + len(u32)
const PROTOCOL_VERSION = 2;

// Mutable runtime configuration shared across the app.
const webrtcConfig = {
  useStun: true,
  useSignalCompression: true,
  useUnorderedFileChannel: true,
  useFastTransfer: true,
  useLanIpOverride: false,
  lanIpOverride: "",
  useTurn: false,
  turnUrl: "",
  turnUsername: "",
  turnCredential: "",
  forceTurnRelay: false,
};

if (!hasStreamCompression()) webrtcConfig.useSignalCompression = false;

const storageSet = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};

const storageGet = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

function setUseStun(enabled) {
  webrtcConfig.useStun = Boolean(enabled);
  storageSet("sharefile_use_stun", webrtcConfig.useStun ? "1" : "0");
}

function setUseSignalCompression(enabled) {
  webrtcConfig.useSignalCompression = Boolean(enabled) && hasStreamCompression();
  storageSet("sharefile_signal_compress", webrtcConfig.useSignalCompression ? "1" : "0");
}

function setUseFileUnordered(enabled) {
  webrtcConfig.useUnorderedFileChannel = Boolean(enabled);
  storageSet("sharefile_file_unordered", webrtcConfig.useUnorderedFileChannel ? "1" : "0");
}

function setUseFastTransfer(enabled) {
  webrtcConfig.useFastTransfer = Boolean(enabled);
  storageSet("sharefile_transfer_fast", webrtcConfig.useFastTransfer ? "1" : "0");
}

function setUseLanIpOverride(enabled) {
  webrtcConfig.useLanIpOverride = Boolean(enabled);
  storageSet("sharefile_lan_ip_override", webrtcConfig.useLanIpOverride ? "1" : "0");
  const box = document.getElementById("lan-ip-override-box");
  if (box) box.style.display = webrtcConfig.useLanIpOverride ? "" : "none";
}

function setLanIpOverrideValue(value) {
  webrtcConfig.lanIpOverride = String(value ?? "");
  storageSet("sharefile_lan_ip_value", webrtcConfig.lanIpOverride);
}

function setUseTurn(enabled) {
  webrtcConfig.useTurn = Boolean(enabled);
  storageSet("sharefile_turn_enabled", webrtcConfig.useTurn ? "1" : "0");
  const box = document.getElementById("turn-config-box");
  if (box) box.style.display = webrtcConfig.useTurn ? "" : "none";
}

function setTurnUrl(value) {
  webrtcConfig.turnUrl = String(value ?? "");
  storageSet("sharefile_turn_url", webrtcConfig.turnUrl);
}

function setTurnUsername(value) {
  webrtcConfig.turnUsername = String(value ?? "");
  storageSet("sharefile_turn_username", webrtcConfig.turnUsername);
}

function setTurnCredential(value) {
  webrtcConfig.turnCredential = String(value ?? "");
  storageSet("sharefile_turn_credential", webrtcConfig.turnCredential);
}

function setForceTurnRelay(enabled) {
  webrtcConfig.forceTurnRelay = Boolean(enabled);
  storageSet("sharefile_turn_force_relay", webrtcConfig.forceTurnRelay ? "1" : "0");
}

function applyRemoteSignalConfig(cfg) {
  // Settings are fixed defaults and hidden from UI; ignore remote config to keep behavior consistent.
  void cfg;
}

// --- Helper Functions ---
function getDeviceMemoryGB() {
  const mem = Number(navigator?.deviceMemory || 0);
  return Number.isFinite(mem) && mem > 0 ? mem : 0;
}

function getFastFileChannelCount() {
  if (!webrtcConfig.useFastTransfer) return 1;

  const mem = getDeviceMemoryGB();
  let count = 2;
  if (mem >= 8) count = 4;
  else if (mem >= 4) count = 3;

  const hc = Number(navigator?.hardwareConcurrency || 0);
  if (Number.isFinite(hc) && hc > 0 && hc <= 4) count = Math.min(count, 2);

  return Math.max(1, Math.min(8, count));
}

function fileStreamIdForIndex(baseId, index) {
  const base = String(baseId ?? "").trim();
  if (!base) return "";
  const i = Number(index) || 0;
  if (!Number.isFinite(i) || i <= 0) return base;
  return `${base}:${i}`;
}

function streamIdMatchesBase(baseId, streamId) {
  const base = String(baseId ?? "").trim();
  const id = String(streamId ?? "").trim();
  if (!base || !id) return false;
  return id === base || id.startsWith(base + ":");
}

function isValidIpv4(ip) {
  const s = String(ip ?? "").trim();
  if (!s) return false;
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0 || n > 255) return false;
  }
  return true;
}

function normalizeLanIpOverride(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return isValidIpv4(s) ? s : "";
}

function rewriteMdnsHostCandidatesInSdp(sdp, ipv4) {
  const ip = normalizeLanIpOverride(ipv4);
  if (!ip) return sdp;
  const text = String(sdp ?? "");
  if (!text) return text;

  const sep = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.startsWith("a=candidate:")) continue;
    if (!line.includes(" typ host")) continue;
    const parts = line.split(" ");
    if (parts.length < 6) continue;
    const addr = parts[4];
    if (!addr || !addr.endsWith(".local")) continue;
    parts[4] = ip;
    lines[i] = parts.join(" ");
    changed = true;
  }

  return changed ? lines.join(sep) : text;
}

const { dcHighWaterMark: DC_BUFFER_HIGH_WATER_MARK, dcLowWaterMark: DC_BUFFER_LOW_WATER_MARK } = (() => {
  // RTCDataChannel send buffer limits vary a lot between browsers; keep conservative to
  // avoid "RTCDataChannel send queue is full" while still allowing good throughput.
  const mem = getDeviceMemoryGB();
  let high = 16 * 1024 * 1024;
  if (mem >= 8) high = 64 * 1024 * 1024;
  else if (mem >= 4) high = 32 * 1024 * 1024;
  else if (mem > 0 && mem < 2) high = 8 * 1024 * 1024;

  const low = Math.max(1024 * 1024, Math.floor(high / 4));
  return { dcHighWaterMark: high, dcLowWaterMark: low };
})();

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function supportsBlobArrayBufferSlice() {
  return typeof Blob !== "undefined" && typeof Blob.prototype?.arrayBuffer === "function";
}

function getBinaryByteLength(data) {
  if (!data) return 0;
  if (typeof data === "string") return data.length;

  if (typeof ArrayBuffer !== "undefined") {
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;

  const size = Number(data.byteLength ?? data.size ?? 0);
  return Number.isFinite(size) ? size : 0;
}

function isDcSendQueueFullError(err) {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return msg.includes("send queue is full");
}

function bytesToBase64(bytes) {
  const parts = [];
  const chunkSize = 0x2000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(""));
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlEncodeBytes(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeToBytes(b64url) {
  let b64 = String(b64url).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  return base64ToBytes(b64);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_LOOKUP = (() => {
  const arr = new Int16Array(256);
  arr.fill(-1);
  for (let i = 0; i < BASE32_ALPHABET.length; i++) {
    arr[BASE32_ALPHABET.charCodeAt(i)] = i;
  }
  return arr;
})();

function base32EncodeBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < data.length; i++) {
    buffer = (buffer << 8) | data[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}

function base32DecodeToBytes(input) {
  const s = String(input ?? "").toUpperCase().replace(/=+$/g, "");
  let buffer = 0;
  let bits = 0;
  const out = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 10 || ch === 13 || ch === 9 || ch === 32) continue; // \n \r \t space
    const val = ch < 256 ? BASE32_LOOKUP[ch] : -1;
    if (val < 0) throw new Error("Invalid base32 character");
    buffer = (buffer << 5) | val;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function hasStreamCompression() {
  return typeof CompressionStream === "function" && typeof DecompressionStream === "function";
}

// --- WebRTC Logic (PeerClient) ---
class PeerClient {
  constructor(onStatusChange, onData) {
    this.pc = null;
    this.dc = null; // control channel
    this.fileChannels = new Map(); // id -> RTCDataChannel
    this.fileTxId = Math.random().toString(36).slice(2);
    this.onStatusChange = onStatusChange;
    this.onData = onData;
    this._ctrlMsgChain = Promise.resolve();
    this._fileMsgChain = Promise.resolve();
    this._hbTimer = 0;
    this._peerTimedOut = false;
    this._lastPeerActivityAt = 0;
    this.remoteCaps = null;
    this._remoteCapsWaiters = new Set(); // Set<(caps|null)=>void>
  }

  async createOffer() {
    this.setupPC();
    this.dc = this.pc.createDataChannel(CTRL_CHANNEL_LABEL, { ordered: true });
    this.setupCtrlDC(this.dc);
    
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitForIceComplete({ timeoutMs: webrtcConfig.useStun ? 15000 : 7000 });
    return this.encodeSignal(this.pc.localDescription);
  }

  async createAnswer(offerCode) {
    const decoded = await this.decodeSignal(offerCode);
    applyRemoteSignalConfig(decoded?.cfg);

    this.setupPC();
    await this.pc.setRemoteDescription({ type: decoded?.type, sdp: decoded?.sdp });

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitForIceComplete({ timeoutMs: webrtcConfig.useStun ? 15000 : 7000 });
    return this.encodeSignal(this.pc.localDescription);
  }

  async applyAnswer(answerCode) {
    const decoded = await this.decodeSignal(answerCode);
    await this.pc.setRemoteDescription({ type: decoded?.type, sdp: decoded?.sdp });
  }

  setupPC() {
    this.stopHeartbeat();
    this._setRemoteCaps(null);
    try { this.dc?.close?.(); } catch {}
    this.dc = null;

    for (const dc of this.fileChannels.values()) {
      try { dc?.close?.(); } catch {}
    }
    this.fileChannels.clear();

    try { this.pc?.close?.(); } catch {}
    const iceServers = [];
    if (webrtcConfig.useStun) {
      iceServers.push({ urls: "stun:stun.l.google.com:19302" });
    }
    if (webrtcConfig.useTurn) {
      const url = String(webrtcConfig.turnUrl ?? "").trim();
      if (url) {
        const server = { urls: url };
        const u = String(webrtcConfig.turnUsername ?? "").trim();
        const p = String(webrtcConfig.turnCredential ?? "");
        if (u) server.username = u;
        if (p) server.credential = p;
        iceServers.push(server);
      }
    }

    const pcConfig = { iceServers };
    if (webrtcConfig.useTurn && webrtcConfig.forceTurnRelay && String(webrtcConfig.turnUrl ?? "").trim()) {
      pcConfig.iceTransportPolicy = "relay";
    }

    this.pc = new RTCPeerConnection(pcConfig);
    // Must be set before remote description, otherwise the event can be missed.
    this.pc.ondatachannel = (e) => {
      try { this.handleDataChannel(e.channel); } catch (err) { console.error(err); }
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.onStatusChange(s);
      if (s === "failed" || s === "closed") {
        this.stopHeartbeat();
      }
    };
  }

  handleDataChannel(dc) {
    if (!dc) return;

    if (dc.label === CTRL_CHANNEL_LABEL) {
      this.dc = dc;
      this.setupCtrlDC(dc);
      return;
    }

    if (dc.label && dc.label.startsWith(FILE_CHANNEL_LABEL_PREFIX)) {
      const id = dc.label.slice(FILE_CHANNEL_LABEL_PREFIX.length);
      this.registerFileChannel(id, dc);
      return;
    }

    // Fallback: treat the first unknown channel as control.
    if (!this.dc) {
      this.dc = dc;
      this.setupCtrlDC(dc);
    }
  }

  setupCtrlDC(dc) {
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = DC_BUFFER_LOW_WATER_MARK;
    dc.onopen = () => {
      this.markPeerActivity();
      try {
        dc.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, caps: { striping: 1 } }));
      } catch {}
      this.startHeartbeat();
      this.onStatusChange("connected");
    };
    dc.onclose = () => {
      this.stopHeartbeat();
      this.onStatusChange("disconnected");
    };
    dc.onmessage = (e) => {
      const payload = e.data;
      this._ctrlMsgChain = this._ctrlMsgChain
        .then(() => this.handleCtrlMessage(payload))
        .catch((err) => console.error(err));
    };
  }

  registerFileChannel(id, dc) {
    const trimmedId = String(id ?? "").trim();
    if (!trimmedId) return;
    if (!dc) return;

    const prev = this.fileChannels.get(trimmedId);
    if (prev && prev !== dc) {
      try { prev.close(); } catch {}
    }
    this.fileChannels.set(trimmedId, dc);

    // Prefer Blob to avoid forcing full ArrayBuffer copies on receive for large transfers.
    try {
      dc.binaryType = supportsBlobArrayBufferSlice() ? "blob" : "arraybuffer";
    } catch {
      dc.binaryType = "arraybuffer";
    }
    dc.bufferedAmountLowThreshold = DC_BUFFER_LOW_WATER_MARK;

    dc.onmessage = (e) => {
      const payload = e.data;
      this._fileMsgChain = this._fileMsgChain
        .then(() => this.handleFileFrame(trimmedId, payload))
        .catch((err) => console.error(err));
    };

    dc.onclose = () => {
      if (this.fileChannels.get(trimmedId) === dc) this.fileChannels.delete(trimmedId);
      this.markPeerActivity();
      Promise.resolve(this.onData({ type: "file-channel-closed", streamId: trimmedId })).catch(console.error);
    };
  }

  getFileTxId() {
    return this.fileTxId;
  }

  async ensureFileTxChannel(options) {
    const timeoutMs = options?.timeoutMs;
    const [dc] = await this.ensureFileTxChannels({ count: 1, timeoutMs });
    return dc || null;
  }

  async ensureFileTxChannels({ count = 1, timeoutMs = 12000 } = {}) {
    const n = Math.max(1, Math.floor(count) || 1);
    const baseId = this.getFileTxId();
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(fileStreamIdForIndex(baseId, i));
    const channels = await Promise.all(ids.map((id) => this.openFileChannel(id, { timeoutMs })));
    return channels.filter(Boolean);
  }

  resetFileTxChannel() {
    this.closeFileChannelsByPrefix(this.fileTxId);
  }

  closeFileChannelsByPrefix(prefix) {
    const base = String(prefix ?? "").trim();
    if (!base) return;
    const ids = Array.from(this.fileChannels.keys());
    for (const id of ids) {
      if (id === base || id.startsWith(base + ":")) {
        this.closeFileChannel(id);
      }
    }
  }

  async openFileChannel(id, { timeoutMs = 12000 } = {}) {
    const transferId = String(id ?? "").trim();
    if (!transferId) throw new Error("Missing transfer id");
    if (!this.pc) throw new Error("Connection not established");

    const existing = this.fileChannels.get(transferId);
    if (existing?.readyState === "open") return existing;
    if (existing?.readyState === "connecting") {
      await this.waitForDataChannelOpen(existing, { timeoutMs });
      return existing;
    }

    if (existing) {
      try { existing.close(); } catch {}
      this.fileChannels.delete(transferId);
    }

    const dc = this.pc.createDataChannel(FILE_CHANNEL_LABEL_PREFIX + transferId, {
      ordered: !webrtcConfig.useUnorderedFileChannel,
    });
    this.registerFileChannel(transferId, dc);
    await this.waitForDataChannelOpen(dc, { timeoutMs });
    return dc;
  }

  getFileChannel(id) {
    const transferId = String(id ?? "").trim();
    if (!transferId) return null;
    return this.fileChannels.get(transferId) || null;
  }

  closeFileChannel(id) {
    const transferId = String(id ?? "").trim();
    if (!transferId) return;
    const dc = this.fileChannels.get(transferId);
    if (!dc) return;
    try { dc.close(); } catch {}
    if (this.fileChannels.get(transferId) === dc) this.fileChannels.delete(transferId);
  }

  waitForDataChannelOpen(dc, { timeoutMs = 12000 } = {}) {
    const timeout = Math.max(1000, Number(timeoutMs) || 0);
    if (!dc) return Promise.reject(new Error("Missing data channel"));
    if (dc.readyState === "open") return Promise.resolve();
    if (dc.readyState === "closed") return Promise.reject(new Error("Data channel closed"));

    return new Promise((resolve, reject) => {
      let done = false;
      let timeoutId = 0;

      const cleanup = () => {
        if (done) return;
        done = true;
        if (timeoutId) clearTimeout(timeoutId);
        dc.removeEventListener?.("open", onOpen);
        dc.removeEventListener?.("close", onClose);
      };

      const onOpen = () => {
        cleanup();
        resolve();
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Data channel closed"));
      };

      try {
        dc.addEventListener?.("open", onOpen);
        dc.addEventListener?.("close", onClose);
      } catch {
        dc.onopen = onOpen;
        dc.onclose = onClose;
      }

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error("Data channel open timeout"));
      }, timeout);
    });
  }

  _setRemoteCaps(caps) {
    this.remoteCaps = caps && typeof caps === "object" ? caps : null;
    if (!this._remoteCapsWaiters?.size) return;
    const waiters = Array.from(this._remoteCapsWaiters);
    this._remoteCapsWaiters.clear();
    for (const resolve of waiters) {
      try { resolve(this.remoteCaps); } catch {}
    }
  }

  waitForRemoteCaps({ timeoutMs = 1200 } = {}) {
    if (this.remoteCaps) return Promise.resolve(this.remoteCaps);
    const timeout = Math.max(0, Math.floor(timeoutMs) || 0);

    return new Promise((resolve) => {
      let timeoutId = 0;
      const onCaps = (caps) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(caps);
      };

      this._remoteCapsWaiters.add(onCaps);
      if (timeout) {
        timeoutId = setTimeout(() => {
          this._remoteCapsWaiters.delete(onCaps);
          resolve(null);
        }, timeout);
      }
    });
  }

  markPeerActivity() {
    this._lastPeerActivityAt = nowMs();
    if (this._peerTimedOut) {
      this._peerTimedOut = false;
      this.onStatusChange("connected");
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this._lastPeerActivityAt = nowMs();
    this._peerTimedOut = false;
    this._hbTimer = setInterval(() => {
      if (!this.dc || this.dc.readyState !== "open") return;

      const idleFor = nowMs() - (this._lastPeerActivityAt || 0);
      if (idleFor > HEARTBEAT_TIMEOUT_MS) {
        if (!this._peerTimedOut) {
          this._peerTimedOut = true;
          this.onStatusChange("peer-timeout");
        }
      }

      try {
        this.dc.send(JSON.stringify({ type: "hb-ping", t: Date.now() }));
      } catch {
        // ignore
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this._hbTimer) {
      clearInterval(this._hbTimer);
      this._hbTimer = 0;
    }
    this._peerTimedOut = false;
  }

  close() {
    this.stopHeartbeat();
    this._setRemoteCaps(null);
    try { this.dc?.close(); } catch {}
    for (const dc of this.fileChannels.values()) {
      try { dc?.close?.(); } catch {}
    }
    this.fileChannels.clear();
    try { this.pc?.close(); } catch {}
  }

  async waitForIceComplete({ timeoutMs = 10000 } = {}) {
    const pc = this.pc;
    if (!pc) return;
    if (pc.iceGatheringState === "complete") return;

    return new Promise((resolve) => {
      let done = false;
      let timeoutId = 0;

      const cleanup = () => {
        if (done) return;
        done = true;
        if (timeoutId) clearTimeout(timeoutId);
        pc.removeEventListener("icegatheringstatechange", onStateChange);
        pc.removeEventListener("icecandidate", onIceCandidate);
        resolve();
      };

      const onStateChange = () => {
        if (pc.iceGatheringState === "complete") cleanup();
      };

      const onIceCandidate = (e) => {
        if (!e.candidate) cleanup();
      };

      pc.addEventListener("icegatheringstatechange", onStateChange);
      pc.addEventListener("icecandidate", onIceCandidate);
      timeoutId = setTimeout(cleanup, Math.max(1000, Number(timeoutMs) || 0));
      onStateChange();
    });
  }

  // --- Signaling Helpers (GZIP + Base64) ---
  async encodeSignal(desc) {
    if (!desc?.type || !desc?.sdp) throw new Error("Missing session description");
    
    let sdp = desc.sdp;
    if (webrtcConfig.useLanIpOverride) {
      sdp = rewriteMdnsHostCandidatesInSdp(sdp, webrtcConfig.lanIpOverride);
    }

    // Embed minimal config to keep both sides aligned.
    const cfg = {
      stun: webrtcConfig.useStun ? 1 : 0,
      fileUnordered: webrtcConfig.useUnorderedFileChannel ? 1 : 0,
      fast: webrtcConfig.useFastTransfer ? 1 : 0,
    };

    const payload = JSON.stringify({ t: desc.type, s: sdp, c: cfg });
    const encodeBytes = (bytes) => base32EncodeBytes(bytes);

    if (webrtcConfig.useSignalCompression && hasStreamCompression()) {
      try {
        const stream = new Blob([payload]).stream().pipeThrough(new CompressionStream("gzip"));
        const buf = await new Response(stream).arrayBuffer();
        return SIGNAL_PREFIX_GZIP_B32 + encodeBytes(new Uint8Array(buf));
      } catch {
        // Fall back to raw encoding
      }
    }

    const buf = await new Response(new Blob([payload])).arrayBuffer();
    return SIGNAL_PREFIX_RAW_B32 + encodeBytes(new Uint8Array(buf));
  }

  async decodeSignal(code) {
    const trimmed = String(code ?? "").trim();
    if (!trimmed) throw new Error("Empty code");

    if (trimmed.startsWith(SIGNAL_PREFIX_GZIP_B32)) {
      if (!hasStreamCompression()) {
        throw new Error(
          "This browser can't decompress the connection code. Ask the other side to regenerate the code without compression."
        );
      }

      const bytes = base32DecodeToBytes(trimmed.slice(SIGNAL_PREFIX_GZIP_B32.length));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      const json = await new Response(stream).json();
      return { type: json?.t, sdp: json?.s, cfg: json?.c };
    }

    if (trimmed.startsWith(SIGNAL_PREFIX_RAW_B32)) {
      const bytes = base32DecodeToBytes(trimmed.slice(SIGNAL_PREFIX_RAW_B32.length));
      const json = await new Response(new Blob([bytes])).json();
      return { type: json?.t, sdp: json?.s, cfg: json?.c };
    }

    if (trimmed.startsWith(SIGNAL_PREFIX_GZIP)) {
      if (!hasStreamCompression()) {
        throw new Error(
          "This browser can't decompress the connection code. Ask the other side to regenerate the code without compression."
        );
      }

      const bytes = base64UrlDecodeToBytes(trimmed.slice(SIGNAL_PREFIX_GZIP.length));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      const json = await new Response(stream).json();
      return { type: json?.t, sdp: json?.s, cfg: json?.c };
    }

    if (trimmed.startsWith(SIGNAL_PREFIX_RAW)) {
      const bytes = base64UrlDecodeToBytes(trimmed.slice(SIGNAL_PREFIX_RAW.length));
      const json = await new Response(new Blob([bytes])).json();
      return { type: json?.t, sdp: json?.s, cfg: json?.c };
    }

    throw new Error("Invalid code format");
  }

  async handleCtrlMessage(data) {
    if (typeof data === "string") {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        this.markPeerActivity();
        await this.onData({ type: "text", text: data });
        return;
      }
      if (msg?.type === "hb-ping") {
        this.markPeerActivity();
        try {
          this.send(JSON.stringify({ type: "hb-pong", t: msg.t ?? Date.now() }));
        } catch {}
        return;
      }
      if (msg?.type === "hb-pong") {
        this.markPeerActivity();
        return;
      }
      if (msg?.type === "hello") {
        this.markPeerActivity();
        const v = Number(msg?.v) || 0;
        const caps = msg?.caps && typeof msg.caps === "object" ? msg.caps : {};
        this._setRemoteCaps({ v, striping: Boolean(caps.striping) });
        return;
      }
      this.markPeerActivity();
      await this.onData(msg);
      return;
    }
    this.markPeerActivity();
    await this.onData({ type: "chunk", data });
  }

  async handleFileFrame(id, data) {
    if (!data) return;
    if (typeof data === "string") return;

    let buf = null;

    // Fast path: receive as Blob and only read the small header; keep payload as Blob to
    // reduce memory pressure for large files.
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      if (data.size < FILE_FRAME_HEADER_BYTES) return;
      if (typeof data.arrayBuffer === "function") {
        const headerBuf = await data.slice(0, FILE_FRAME_HEADER_BYTES).arrayBuffer();
        const view = new DataView(headerBuf);
        const seq = view.getUint32(0);
        const declaredLen = view.getUint32(4);
        const payloadLen = Math.max(0, data.size - FILE_FRAME_HEADER_BYTES);
        const len = declaredLen && declaredLen <= payloadLen ? declaredLen : payloadLen;
        const payload = data.slice(FILE_FRAME_HEADER_BYTES, FILE_FRAME_HEADER_BYTES + len);
        this.markPeerActivity();
        await this.onData({ type: "file-chunk", streamId: id, seq, data: payload });
        return;
      }
      // Fallback: older browsers; decode whole message.
      buf = await new Response(data).arrayBuffer();
    } else if (data instanceof ArrayBuffer) {
      buf = data;
    } else if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView?.(data)) {
      buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }

    if (!buf || buf.byteLength < FILE_FRAME_HEADER_BYTES) return;

    const view = new DataView(buf);
    const seq = view.getUint32(0);
    const declaredLen = view.getUint32(4);
    const payloadLen = Math.max(0, buf.byteLength - FILE_FRAME_HEADER_BYTES);
    const len = declaredLen && declaredLen <= payloadLen ? declaredLen : payloadLen;
    const payload = new Uint8Array(buf, FILE_FRAME_HEADER_BYTES, len);

    this.markPeerActivity();
    await this.onData({ type: "file-chunk", streamId: id, seq, data: payload });
  }

  send(data) {
    if (this.dc?.readyState === "open") this.dc.send(data);
  }

  async waitForBuffer(
    dc = this.dc,
    { highWaterMark = DC_BUFFER_HIGH_WATER_MARK, lowWaterMark = DC_BUFFER_LOW_WATER_MARK, timeoutMs = 10_000, signal } = {}
  ) {
    if (!dc) return;
    if (dc.readyState !== "open") return;
    const high = Math.max(0, Math.floor(highWaterMark) || 0);
    const low = Math.max(0, Math.floor(lowWaterMark) || 0);
    const timeout = Math.max(0, Math.floor(timeoutMs) || 0);
    if (dc.bufferedAmount <= high) return;

    return new Promise((resolve, reject) => {
      let iv = 0;
      let timeoutId = 0;
      let aborted = false;
      const cleanup = () => {
        dc.removeEventListener("bufferedamountlow", onLow);
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

      const onLow = () => check();

      const check = () => {
        if (signal?.aborted) return onAbort();
        if (dc.readyState !== "open") return cleanup();
        if (dc.bufferedAmount <= low) return cleanup();
      };

      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      dc.addEventListener("bufferedamountlow", onLow, { once: true });
      iv = setInterval(check, 50);
      if (timeout) timeoutId = setTimeout(cleanup, timeout);
      check();
    });
  }
}

function createAbortError(message = "Canceled") {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

function isAbortError(err) {
  return err?.name === "AbortError";
}

export {
  applyRemoteSignalConfig,
  base32DecodeToBytes,
  base32EncodeBytes,
  base64UrlDecodeToBytes,
  CTRL_CHANNEL_LABEL,
  DC_BUFFER_HIGH_WATER_MARK,
  DC_BUFFER_LOW_WATER_MARK,
  FILE_CHANNEL_LABEL_PREFIX,
  FILE_CHUNK_SIZE,
  FILE_FRAME_HEADER_BYTES,
  getBinaryByteLength,
  getFastFileChannelCount,
  hasStreamCompression,
  createAbortError,
  isAbortError,
  isDcSendQueueFullError,
  normalizeLanIpOverride,
  nowMs,
  PeerClient,
  PROTOCOL_VERSION,
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
  streamIdMatchesBase,
  UI_PROGRESS_MIN_INTERVAL_MS,
  webrtcConfig,
};
