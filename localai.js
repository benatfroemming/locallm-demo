/**
 * localai.js
 * Client library for LocalAI — browser-side local model inference.
 *
 * Usage:
 *   import { localai } from "./localai.js"
 *
 *   await localai.init()
 *   const models  = await localai.models()
 *   const def     = await localai.defaultModel()
 *   await localai.setDefaultModel("SmolLM2 135M")
 *   const reply   = await localai.prompt({ messages: [...] })
 *   const { promise, abort } = localai.promptAbortable({ messages: [...], onToken: (t) => ... })
 *   abort()               // stop mid-stream; promise still resolves with partial text
 */

// ── Config ────────────────────────────────────────────────────────────────────

const BRIDGE_ORIGIN = "https://benatfroemming.github.io";
const BRIDGE_URL    = `${BRIDGE_ORIGIN}/locallm/bridge.html`;

const PERM_KEY = () => `localai_perm_${window.location.origin}`;

// ── Internal state ────────────────────────────────────────────────────────────

let _iframe      = null;
let _ready       = false;
let _readyQueue  = [];
let _pending     = {};
let _initPromise = null;

// ── postMessage listener ──────────────────────────────────────────────────────

window.addEventListener("message", (e) => {
  if (e.origin !== BRIDGE_ORIGIN) return;
  const msg = e.data;
  if (!msg?.type) return;

  if (msg.type === "LOCALAI_READY") {
    _ready = true;
    _readyQueue.forEach((fn) => fn());
    _readyQueue = [];
    return;
  }

  if (msg.type === "LOCALAI_MODELS") {
    const listReq = _pending["__list__"];
    if (listReq) {
      listReq.resolve(msg.models);
      delete _pending["__list__"];
    }
    return;
  }

  if (msg.type === "LOCALAI_DEFAULT_SET") {
    const req = _pending["__setdefault__"];
    if (req) {
      req.resolve(msg.modelId);
      delete _pending["__setdefault__"];
    }
    return;
  }

  const req = _pending[msg.id];
  if (!req) return;

  if (msg.type === "LOCALAI_STATUS") return;

  if (msg.type === "LOCALAI_TOKEN") {
    if (typeof req.onToken === "function") req.onToken(msg.token);
    req._chunks.push(msg.token);
    return;
  }

  if (msg.type === "LOCALAI_DONE") {
    req.resolve(req._chunks.join(""));
    delete _pending[msg.id];
    return;
  }

  if (msg.type === "LOCALAI_ERROR") {
    req.reject(new Error(msg.message));
    delete _pending[msg.id];
    return;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function _waitForBridge() {
  return new Promise((resolve) => {
    if (_ready) return resolve();
    _readyQueue.push(resolve);
  });
}

function _injectBridge() {
  if (_iframe) return;
  _iframe = document.createElement("iframe");
  _iframe.src = BRIDGE_URL;
  _iframe.style.cssText = "display:none;position:absolute;width:0;height:0;border:0";
  _iframe.sandbox = "allow-scripts allow-same-origin";
  _iframe.addEventListener("load", () => {
    _iframe.contentWindow.postMessage({ type: "LOCALAI_HELLO" }, BRIDGE_ORIGIN);
  });
  document.body.appendChild(_iframe);
}

async function _send(msg) {
  await _waitForBridge();
  _iframe.contentWindow.postMessage(msg, BRIDGE_ORIGIN);
}

function _askPermission() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.45); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `;

    const box = document.createElement("div");
    box.style.cssText = `
      background: #fff; border-radius: 14px; padding: 28px 28px 22px;
      max-width: 360px; width: calc(100% - 48px);
      box-shadow: 0 20px 60px rgba(0,0,0,0.18);
    `;

    const icon = document.createElement("div");
    icon.textContent = "🧠";
    icon.style.cssText = "font-size: 28px; margin-bottom: 12px;";

    const title = document.createElement("p");
    title.textContent = "Allow local AI models?";
    title.style.cssText = "font-size: 16px; font-weight: 600; color: #111; margin-bottom: 8px;";

    const body = document.createElement("p");
    body.innerHTML = `<strong>${window.location.hostname}</strong> wants to run inference using models cached in your browser. No data leaves your device.`;
    body.style.cssText = "font-size: 13px; color: #555; line-height: 1.55; margin-bottom: 22px;";

    const row = document.createElement("div");
    row.style.cssText = "display: flex; gap: 10px;";

    const btnAllow = document.createElement("button");
    btnAllow.textContent = "Allow";
    btnAllow.style.cssText = `
      flex: 1; padding: 10px; border-radius: 8px; border: none;
      background: #111; color: #fff; font-size: 14px; font-weight: 500;
      cursor: pointer; font-family: inherit;
    `;

    const btnDeny = document.createElement("button");
    btnDeny.textContent = "Don't allow";
    btnDeny.style.cssText = `
      flex: 1; padding: 10px; border-radius: 8px;
      border: 1px solid #e5e7eb; background: #fff; color: #333;
      font-size: 14px; cursor: pointer; font-family: inherit;
    `;

    btnAllow.addEventListener("click", () => { overlay.remove(); resolve(true);  });
    btnDeny.addEventListener("click",  () => { overlay.remove(); resolve(false); });

    row.append(btnAllow, btnDeny);
    box.append(icon, title, body, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

const localai = {

  /** Initialize the bridge. Shows a permission prompt on first use. */
  async init() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      const key = PERM_KEY();
      const stored = localStorage.getItem(key);

      if (stored === "granted") {
        _injectBridge();
        return;
      }

      if (stored === "denied") {
        throw new Error("LocalAI: permission was previously denied by the user.");
      }

      const approved = await _askPermission();

      if (!approved) {
        localStorage.setItem(key, "denied");
        throw new Error("LocalAI: user denied permission.");
      }

      localStorage.setItem(key, "granted");
      _injectBridge();
    })();

    return _initPromise;
  },

  /** Returns all cached model objects: [{ id, name, task, default }, ...] */
  async models() {
    _assertInit();
    await _send({ type: "LOCALAI_LIST" });

    return new Promise((resolve, reject) => {
      _pending["__list__"] = { resolve, reject };
      setTimeout(() => {
        if (_pending["__list__"]) {
          delete _pending["__list__"];
          reject(new Error("LocalAI: timed out waiting for model list."));
        }
      }, 8000);
    });
  },

  /** Returns the name of the default model (throws if none cached). */
  async defaultModel() {
    _assertInit();
    const list = await localai.models();

    if (list.length === 0) {
      throw new Error("LocalAI: no models cached. Visit the dashboard to download one.");
    }

    const pinned = list.find((m) => m.default);
    return pinned ? pinned.name : list[0].name;
  },

  /**
   * Pin a model as the default.
   * @param {string} modelNameOrId  Model name or id. Pass null to clear.
   */
  async setDefaultModel(modelNameOrId) {
    _assertInit();
    let modelId = null;

    if (modelNameOrId !== null && modelNameOrId !== undefined) {
      const list = await localai.models();
      const found = list.find(
        (m) => m.name === modelNameOrId || m.id === modelNameOrId
      );
      if (!found) throw new Error(`LocalAI: model "${modelNameOrId}" not found in cache.`);
      modelId = found.id;
    }

    await _send({ type: "LOCALAI_SET_DEFAULT", modelId });

    return new Promise((resolve, reject) => {
      _pending["__setdefault__"] = { resolve, reject };
      setTimeout(() => {
        if (_pending["__setdefault__"]) {
          delete _pending["__setdefault__"];
          reject(new Error("LocalAI: timed out setting default model."));
        }
      }, 5000);
    });
  },

  /**
   * Run inference. Resolves with the full text when generation ends.
   *
   * @param {object} options
   * @param {string}   [options.model]    Model name or id. Defaults to defaultModel().
   * @param {Array}    options.messages   OpenAI-style messages: [{ role, content }, ...]
   * @param {Function} [options.onToken]  Called with each token as it streams.
   * @returns {Promise<string>}
   */
  async prompt({ model, messages, onToken } = {}) {
    const { promise } = localai.promptAbortable({ model, messages, onToken });
    return promise;
  },

  /**
   * Run inference with an abort handle.
   * Calling abort() sends an interrupt — generation stops and the promise
   * resolves with the partial text generated so far.
   *
   * @param {object} options  Same as prompt()
   * @returns {{ promise: Promise<string>, abort: () => void }}
   */
  promptAbortable({ model, messages, onToken, maxTokens = 256 } = {}) {
    _assertInit();

    if (!messages?.length) {
      throw new Error("LocalAI: messages array is required.");
    }

    const id = crypto.randomUUID();
    let aborted = false;

    const promise = (async () => {
      const list = await localai.models();
      if (list.length === 0) throw new Error("LocalAI: no models cached.");

      let targetModel;
      if (model) {
        targetModel = list.find((m) => m.name === model || m.id === model);
        if (!targetModel) throw new Error(`LocalAI: model "${model}" not found in cache.`);
      } else {
        const def = await localai.defaultModel();
        targetModel = list.find((m) => m.name === def) ?? list[0];
      }

      return new Promise((resolve, reject) => {
        _pending[id] = { resolve, reject, onToken, _chunks: [] };

        _send({
          type: "LOCALAI_RUN",
          id,
          modelId: targetModel.id,
          messages,
          maxTokens,
        });

        setTimeout(() => {
          if (_pending[id]) {
            delete _pending[id];
            reject(new Error("LocalAI: inference timed out."));
          }
        }, 120_000); // 2 min — generous for slow WASM devices
      });
    })();

    const abort = () => {
      if (aborted) return;
      aborted = true;
      _send({ type: "LOCALAI_ABORT", id });
    };

    return { promise, abort };
  },

  /** Reset the stored permission for this origin (useful for testing). */
  resetPermission() {
    localStorage.removeItem(PERM_KEY());
    _initPromise = null;
  },
};

// ── Internal guard ────────────────────────────────────────────────────────────

function _assertInit() {
  if (!_initPromise) {
    throw new Error("LocalAI: call localai.init() before using other methods.");
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

export { localai };
export default localai;
