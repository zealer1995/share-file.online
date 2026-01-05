import { createClient } from "@supabase/supabase-js";

function makeClientId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export class SignalingService {
  constructor(url, key) {
    this.supabase = createClient(url, key);
    this.channel = null;
    this.roomId = null;
    this.clientId = makeClientId();

    this.onMessage = null; // (dataStr: string) => void
    this.onOpen = null; // () => void
    this.onError = null; // (err: Error) => void

    this.isConnected = false;
    this._lastErrorAt = 0;
    this._lastErrorMsg = "";
  }

  emitError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    if (msg === this._lastErrorMsg && now - this._lastErrorAt < 4000) return;
    this._lastErrorAt = now;
    this._lastErrorMsg = msg;
    this.onError?.(err instanceof Error ? err : new Error(msg));
  }

  async connect(roomId) {
    this.disconnect();
    this.roomId = roomId;
    console.log("Connecting to Supabase room:", roomId);

    // Use Realtime Broadcast for signaling (no DB table/RLS required).
    this.channel = this.supabase
      .channel(`room:${roomId}`, {
        config: {
          broadcast: { ack: true, self: false },
        },
      })
      .on("broadcast", { event: "msg" }, (packet) => {
        const payload = packet?.payload;
        const senderId = payload?.senderId;
        const dataStr = payload?.dataStr;
        if (!dataStr) return;
        if (senderId && senderId === this.clientId) return;
        this.onMessage?.(dataStr);
      })
      .subscribe((status) => {
        console.log(`[Signaling] Room ${roomId} subscription status:`, status);
        if (status === "SUBSCRIBED") {
          this.isConnected = true;
          this.onOpen?.();
          return;
        }

        if (status === "CHANNEL_ERROR") {
          const err = new Error("Channel Error");
          this.isConnected = false;
          console.error("[Signaling] Channel Error. Check URL/Key or network.", err);
          this.emitError(err);
          return;
        }

        if (status === "TIMED_OUT") {
          const err = new Error("Connection Timed Out");
          this.isConnected = false;
          console.error("[Signaling] Connection Timed Out.", err);
          this.emitError(err);
          return;
        }

        if (status === "CLOSED") {
          this.isConnected = false;
        }
      });
  }

  async send(dataStr) {
    if (!this.roomId || !this.channel || !this.isConnected) return;
    try {
      const res = await this.channel.send({
        type: "broadcast",
        event: "msg",
        payload: { senderId: this.clientId, dataStr },
      });
      if (res !== "ok") {
        const err = new Error(`Realtime Send Failed: ${res}`);
        console.error("[Signaling] Send failed:", err);
        this.emitError(err);
      }
    } catch (err) {
      console.error("[Signaling] Send exception:", err);
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  disconnect() {
    if (this.channel) {
      this.supabase.removeChannel(this.channel);
      this.channel = null;
    }
    this.isConnected = false;
    this.roomId = null;
  }
}
