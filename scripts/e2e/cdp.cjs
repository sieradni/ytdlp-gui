//! minimal cdp driver for the real tauri webview (e2e checklist runner).
//! zero deps: raw ws frames + json. drives the REAL app window — real ipc,
//! real yt-dlp processes.

const http = require("http");
const crypto = require("crypto");
const { EventEmitter } = require("events");

// frame-fragmentation guard: chunked continuation frames arrive as events;
// stash them so a JS-string "frame" never splits mid-opcode.
class FrameStash extends EventEmitter {}

function maskKey(key) {
  const m = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) m[i] = key[i] & 0xff;
  return m;
}

function encodeFrame(opcode, payload) {
  const data = Buffer.from(payload, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len; // FIN + 7-bit len
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
  }
  header[0] = 0x80 | opcode;
  header[1] |= 0x80; // client frames are always masked
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

class WsClient extends FrameStash {
  constructor(url) {
    super();
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const key = crypto.randomBytes(16).toString("base64");
      const req = http.request({
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": 13,
        },
      });
      req.on("upgrade", (res, socket) => {
        this.socket = socket;
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", (e) => this.emit("error", e));
        socket.on("close", () => this.emit("close"));
        resolve();
      });
      req.on("error", reject);
      req.end();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buffer.length < off + len) return;
      const payload = this.buffer.subarray(off, off + len);
      this.buffer = this.buffer.subarray(off + len);
      this.handleFrame(opcode, (b0 & 0x80) !== 0, payload);
    }
  }

  handleFrame(opcode, fin, payload) {
    if (opcode === 0x8) { this.close(); return; } // close
    if (opcode === 0x9) { // ping -> pong
      this.socket.write(encodeFrame(0xA, payload));
      return;
    }
    if (opcode === 0xA) return; // pong
    if (!fin || opcode === 0x0) { // fragmented: stash until the FIN frame
      this.fragments.push(payload);
      if (!fin) return;
      const full = Buffer.concat(this.fragments);
      this.fragments = [];
      this.emit("message", full.toString("utf8"));
      return;
    }
    this.emit("message", payload.toString("utf8"));
  }

  send(obj) {
    const id = ++this.id;
    const msg = JSON.stringify({ ...obj, id });
    this.socket.write(encodeFrame(1, msg));
    return id;
  }

  // request/response with timeout
  call(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.send({ method, params });
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, t, method });
    });
  }

  onMessage(str) {
    let m;
    try { m = JSON.parse(str); } catch { return; }
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(p.t);
      if (m.error) p.reject(new Error(`cdp ${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
      return;
    }
    if (m.method) this.emit("event", m);
  }
}

// wire message events into the pending-map + event emitter
function wireClient(ws) {
  ws.on("message", (str) => ws.onMessage(str));
}

async function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

/** launch the exe with remote debugging and return the page-level ws client.
 * webview2 reads its browser args from the env var — a host-exe cli switch
 * does not propagate to the msedgewebview2 host process. */
async function launchAndAttach(exePath, port) {
  const { spawn } = require("child_process");
  const child = spawn(exePath, [], {
    stdio: "ignore",
    detached: false,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, // eslint-disable-line
    },
  });
  child.unref();
  // wait for the debug endpoint
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      targets = await httpJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((t) => t.type === "page" && !/devtools/.test(t.url));
      if (page) {
        const ws = new WsClient(page.webSocketDebuggerUrl);
        wireClient(ws);
        await ws.connect();
        await ws.call("Runtime.enable");
        await ws.call("Page.enable");
        return { ws, child, pid: child.pid };
      }
    } catch { /* not up yet */ }
  }
  throw new Error("webview debug endpoint never came up");
}

/** send a REAL key event through cdp input domain. unlike a synthetic
 * KeyboardEvent, default actions apply — text lands in a focused editable
 * (Enter inserts a newline in a textarea, etc.). modifiers: alt=1, ctrl=2,
 * meta=4, shift=8. */
async function pressKey(ws, { key, code, keyCode, text, modifiers = 0 }) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await ws.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  if (text !== undefined) {
    await ws.call("Input.dispatchKeyEvent", { type: "char", ...base, text, unmodifiedText: text });
  }
  await ws.call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** poll a page-side async fn until truthy (or timeout) */
async function waitFor(ws, expr, { timeoutMs = 20000, everyMs = 300 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await ws.call("Runtime.evaluate", {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "page threw");
      if (r.result && r.result.value !== null && r.result.value !== undefined && r.result.value !== false) {
        return r.result.value;
      }
      last = r.result && r.result.value;
    } catch (e) {
      last = e.message;
    }
    await sleep(everyMs);
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms): ${expr} — last=${JSON.stringify(last)}`);
}

/** evaluate an async page function by value */
async function evalAsync(ws, expr) {
  const r = await ws.call("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(
      `page threw: ${d.text ?? ""} ${d.exception?.description ?? JSON.stringify(d.exception ?? null)} [line ${d.lineNumber}]`,
    );
  }
  return r.result.value;
}

module.exports = { launchAndAttach, waitFor, evalAsync, sleep, pressKey, httpJson, WsClient, wireClient };
