/**
 * localai.js
 *
 * A zero-dependency browser library that lets any web page talk to a user's
 * locally-cached AI models via the LocalAI dashboard bridge.
 *
 * Usage:
 *   const ai = new LocalAI({ bridgeUrl: "http://localhost:5173/bridge.html" });
 *   await ai.connect();                      // asks permission, then handshakes
 *   const models = await ai.getModels();     // [{ id, name, isDefault }, ...]
 *   const def    = await ai.getDefault();    // { id, name, isDefault } | null
 *   const text   = await ai.run({
 *     messages: [{ role: "user", content: "Hello!" }],
 *     modelId:  "HuggingFaceTB/SmolLM2-135M-Instruct",
 *     maxTokens: 200,
 *     temperature: 0.7,
 *     onToken: (t) => process.stdout.write(t),
 *   });
 *   ai.cancel(requestId);                    // abort an in-flight run()
 *   ai.disconnect();                         // tear everything down
 */

"use strict";

// ── Constants ──────────────────────────────────────────────────────────────────

const PERMISSION_KEY   = "localai_permission";   // sessionStorage key
const HANDSHAKE_TIMEOUT = 8_000;                 // ms to wait for LOCALAI_READY
const REQUEST_TIMEOUT   = 120_000;               // ms before auto-cancelling run()
const IFRAME_STYLE      = [
  "position:fixed", "top:-9999px", "left:-9999px",
  "width:1px",      "height:1px",  "border:none",
  "pointer-events:none", "visibility:hidden",
].join(";");

// ── Helpers ────────────────────────────────────────────────────────────────────

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Permission UI ──────────────────────────────────────────────────────────────

/**
 * Shows an accessible, no-dependency permission dialog.
 * Returns a Promise that resolves true (grant) or false (deny).
 */
function showPermissionDialog(origin) {
  return new Promise((resolve) => {
    // Overlay
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position:       "fixed",
      inset:          "0",
      background:     "rgba(0,0,0,0.55)",
      display:        "flex",
      alignItems:     "center",
      justifyContent: "center",
      zIndex:         "2147483647",
      fontFamily:     "system-ui, sans-serif",
    });
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "lai-title");
    overlay.setAttribute("aria-describedby", "lai-desc");

    // Card
    overlay.innerHTML = `
      <div style="
        background:#fff; color:#111; border-radius:12px; padding:28px 32px;
        max-width:400px; width:90%; box-shadow:0 8px 32px rgba(0,0,0,.28);
      ">
        <p style="margin:0 0 6px;font-size:11px;letter-spacing:.08em;
                  text-transform:uppercase;color:#888;font-weight:500;">
          Local AI · permission request
        </p>
        <h2 id="lai-title" style="margin:0 0 12px;font-size:17px;font-weight:600;">
          Allow access to local models?
        </h2>
        <p id="lai-desc" style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#444;">
          <strong style="color:#111;">${origin}</strong> wants to run AI inference
          using models you have downloaded in the LocalAI dashboard.
          No data is sent to any server.
        </p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="lai-deny"  style="
            padding:9px 20px;border-radius:7px;border:1px solid #ddd;
            background:#f5f5f5;color:#333;cursor:pointer;font-size:14px;font-weight:500;
          ">Deny</button>
          <button id="lai-grant" style="
            padding:9px 20px;border-radius:7px;border:none;
            background:#6f5ff6;color:#fff;cursor:pointer;font-size:14px;font-weight:600;
          ">Allow</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // Focus the Allow button so keyboard users can immediately press Enter
    overlay.querySelector("#lai-grant").focus();

    function finish(granted) {
      overlay.remove();
      resolve(granted);
    }

    overlay.querySelector("#lai-grant").addEventListener("click", () => finish(true));
    overlay.querySelector("#lai-deny").addEventListener("click",  () => finish(false));

    // Escape key = deny
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") finish(false);
    });
  });
}

// ── LocalAI class ──────────────────────────────────────────────────────────────

export class LocalAI {
  /**
   * @param {object} opts
   * @param {string}   opts.bridgeUrl          Full URL to bridge.html (required)
   * @param {boolean}  [opts.skipPermission]   Skip the permission dialog (e.g. for the dashboard itself)
   * @param {string}   [opts.appName]          Shown in the permission dialog instead of window.location.origin
   */
  constructor({ bridgeUrl, skipPermission = false, appName } = {}) {
    if (!bridgeUrl) throw new Error("LocalAI: bridgeUrl is required");

    this._bridgeUrl      = bridgeUrl;
    this._skipPermission = skipPermission;
    this._appName        = appName;

    this._iframe    = null;   // HTMLIFrameElement
    this._ready     = false;  // true after LOCALAI_READY received
    this._pending   = {};     // requestId → { resolve, reject, onToken, timer }
    this._onMessage = this._handleMessage.bind(this);

    // Parse bridge origin once so we can validate every inbound message
    this._bridgeOrigin = new URL(bridgeUrl).origin;
  }

  // ── connect() ──────────────────────────────────────────────────────────────

  /**
   * Asks the user for permission (once per session) then performs the
   * LOCALAI_INIT → LOCALAI_READY handshake with the bridge iframe.
   *
   * @returns {Promise<void>} Resolves when the bridge is ready.
   * @throws  If the user denies permission, or the handshake times out.
   */
  async connect() {
    if (this._ready) return;

    // ── 1. Permission ──────────────────────────────────────────────────────

    const origin = this._appName ?? window.location.origin;

    if (!this._skipPermission) {
      const sessionKey = `${PERMISSION_KEY}:${this._bridgeOrigin}`;
      const cached = sessionStorage.getItem(sessionKey);

      if (cached === "denied") {
        throw new Error("LocalAI: permission was denied this session.");
      }

      if (cached !== "granted") {
        const granted = await showPermissionDialog(origin);
        sessionStorage.setItem(sessionKey, granted ? "granted" : "denied");
        if (!granted) throw new Error("LocalAI: user denied permission.");
      }
    }

    // ── 2. Create iframe ───────────────────────────────────────────────────

    this._iframe = document.createElement("iframe");
    this._iframe.setAttribute("style", IFRAME_STYLE);
    this._iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    this._iframe.src = this._bridgeUrl;

    window.addEventListener("message", this._onMessage);
    document.body.appendChild(this._iframe);

    // ── 3. Wait for iframe load, then send LOCALAI_INIT ────────────────────

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("LocalAI: bridge iframe failed to load."));
      }, HANDSHAKE_TIMEOUT);

      this._iframe.addEventListener("load", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });

    // ── 4. LOCALAI_INIT → wait for LOCALAI_READY ──────────────────────────

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("LocalAI: handshake timed out — bridge did not respond."));
      }, HANDSHAKE_TIMEOUT);

      // Temporarily listen for LOCALAI_READY before _ready is set
      const listener = (e) => {
        if (e.origin !== this._bridgeOrigin) return;
        if (e.data?.type === "LOCALAI_READY") {
          clearTimeout(timer);
          window.removeEventListener("message", listener);
          this._ready = true;
          resolve();
        }
      };
      window.addEventListener("message", listener);

      // Initiate handshake — bridge locks our origin after this
      this._iframe.contentWindow.postMessage(
        { type: "LOCALAI_INIT" },
        this._bridgeOrigin
      );
    });
  }

  // ── getModels() ────────────────────────────────────────────────────────────

  /**
   * Returns all models currently cached in the LocalAI dashboard.
   * @returns {Promise<Array<{ id: string, name: string, task: string, isDefault: boolean }>>}
   */
  getModels() {
    this._assertReady();
    return new Promise((resolve, reject) => {
      const id = uid();
      const timer = setTimeout(() => {
        delete this._pending[id];
        reject(new Error("LocalAI: getModels() timed out."));
      }, 10_000);

      // LIST uses a lightweight one-shot pending slot
      this._pending[id] = {
        kind: "list",
        resolve: (models) => { clearTimeout(timer); resolve(models); },
        reject:  (err)    => { clearTimeout(timer); reject(err); },
      };

      this._post({ type: "LOCALAI_LIST", id });
    });
  }

  // ── getDefault() ───────────────────────────────────────────────────────────

  /**
   * Returns the default model, or null if nothing is cached.
   * @returns {Promise<{ id: string, name: string, task: string, isDefault: boolean } | null>}
   */
  async getDefault() {
    const models = await this.getModels();
    return models.find((m) => m.isDefault) ?? null;
  }

  // ── setDefault() ───────────────────────────────────────────────────────────

  /**
   * Pins a model as the new default in the LocalAI dashboard.
   * @param {string | null} modelId  Pass null to clear the default.
   * @returns {Promise<{ modelId: string | null }>}
   */
  setDefault(modelId) {
    this._assertReady();
    return new Promise((resolve, reject) => {
      const id = uid();
      const timer = setTimeout(() => {
        delete this._pending[id];
        reject(new Error("LocalAI: setDefault() timed out."));
      }, 10_000);

      this._pending[id] = {
        kind: "set_default",
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      };

      this._post({ type: "LOCALAI_SET_DEFAULT", id, modelId: modelId ?? null });
    });
  }

  // ── run() ──────────────────────────────────────────────────────────────────

  /**
   * Runs inference on a local model and returns the completed response text.
   *
   * @param {object}   opts
   * @param {Array}    opts.messages         OpenAI-style message array
   * @param {string}   [opts.modelId]        Defaults to the user's default model
   * @param {number}   [opts.maxTokens=256]
   * @param {number}   [opts.temperature=0.7]
   * @param {number}   [opts.top_p=0.9]
   * @param {function} [opts.onToken]        Called with each streamed token string
   *
   * @returns {Promise<{ id: string, text: string }>}
   *   Resolves with the full concatenated response and the request id (for cancel()).
   */
  async run({
    messages,
    modelId,
    maxTokens   = 256,
    temperature = 0.7,
    top_p       = 0.9,
    onToken,
  } = {}) {
    this._assertReady();

    if (!messages?.length) throw new Error("LocalAI: messages array is required.");

    // Resolve modelId from default if not supplied
    if (!modelId) {
      const def = await this.getDefault();
      if (!def) throw new Error("LocalAI: no models are cached. Download one first.");
      modelId = def.id;
    }

    const id = uid();

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancel(id);
        delete this._pending[id];
        reject(new Error(`LocalAI: run() timed out after ${REQUEST_TIMEOUT / 1000}s.`));
      }, REQUEST_TIMEOUT);

      this._pending[id] = {
        kind:    "run",
        buf:     "",          // accumulates streamed tokens
        onToken: onToken ?? null,
        resolve: (text) => { clearTimeout(timer); resolve({ id, text }); },
        reject:  (err)  => { clearTimeout(timer); reject(err); },
      };
    });

    this._post({ type: "LOCALAI_RUN", id, messages, modelId, maxTokens, temperature, top_p });

    return promise;
  }

  // ── cancel() ──────────────────────────────────────────────────────────────

  /**
   * Sends an abort signal for an in-flight run().
   * The run()'s Promise will still resolve (with whatever was generated so far)
   * rather than reject, matching the bridge's behavior.
   *
   * @param {string} requestId  The id returned by (or pending from) run()
   */
  cancel(requestId) {
    if (!this._ready || !requestId) return;
    this._post({ type: "LOCALAI_ABORT", id: requestId });
  }

  // ── disconnect() ──────────────────────────────────────────────────────────

  /**
   * Tears down the bridge iframe and rejects all pending requests.
   */
  disconnect() {
    window.removeEventListener("message", this._onMessage);

    for (const [, entry] of Object.entries(this._pending)) {
      entry.reject(new Error("LocalAI: disconnected."));
    }
    this._pending = {};
    this._ready   = false;

    if (this._iframe) {
      this._iframe.remove();
      this._iframe = null;
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _assertReady() {
    if (!this._ready) throw new Error("LocalAI: call connect() first.");
  }

  _post(msg) {
    this._iframe?.contentWindow?.postMessage(msg, this._bridgeOrigin);
  }

  _handleMessage(e) {
    // Only accept messages from the locked-in bridge origin
    if (e.origin !== this._bridgeOrigin) return;
    const msg = e.data;
    if (!msg?.type) return;

    // ── LOCALAI_MODELS (response to LIST) ─────────────────────────────────
    if (msg.type === "LOCALAI_MODELS") {
      // Find the pending LIST slot (there should only be one at a time)
      for (const [id, entry] of Object.entries(this._pending)) {
        if (entry.kind === "list") {
          delete this._pending[id];
          entry.resolve(msg.models ?? []);
          return;
        }
      }
      return;
    }

    // ── LOCALAI_DEFAULT_SET ────────────────────────────────────────────────
    if (msg.type === "LOCALAI_DEFAULT_SET") {
      for (const [id, entry] of Object.entries(this._pending)) {
        if (entry.kind === "set_default") {
          delete this._pending[id];
          entry.resolve({ modelId: msg.modelId });
          return;
        }
      }
      return;
    }

    // For run-related messages we need the id
    const id = msg.id;
    if (!id) return;
    const entry = this._pending[id];
    if (!entry) return;

    // ── LOCALAI_STATUS ─────────────────────────────────────────────────────
    if (msg.type === "LOCALAI_STATUS") {
      // Informational — no action needed, but could be surfaced via a callback
      // if the developer passes onStatus. Not implemented here to keep the API
      // surface minimal.
      return;
    }

    // ── LOCALAI_TOKEN ──────────────────────────────────────────────────────
    if (msg.type === "LOCALAI_TOKEN") {
      entry.buf += msg.token;
      entry.onToken?.(msg.token);
      return;
    }

    // ── LOCALAI_DONE ───────────────────────────────────────────────────────
    if (msg.type === "LOCALAI_DONE") {
      delete this._pending[id];
      entry.resolve(entry.buf);
      return;
    }

    // ── LOCALAI_ERROR ──────────────────────────────────────────────────────
    if (msg.type === "LOCALAI_ERROR") {
      delete this._pending[id];
      entry.reject(new Error(`LocalAI: ${msg.message ?? "inference error"}`));
      return;
    }
  }
}
