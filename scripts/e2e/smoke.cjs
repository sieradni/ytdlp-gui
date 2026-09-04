const path = require("path");
const { launchAndAttach, evalAsync, sleep } = require("./cdp.cjs");

(async () => {
  const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");
  console.log("launching", exe);
  const { ws, pid } = await launchAndAttach(exe, 9333);
  await sleep(2000);
  console.log("title:", await evalAsync(ws, "document.title"));
  console.log("tabs:", await evalAsync(ws, "[...document.querySelectorAll('.tab-btn')].map(b => b.textContent.trim())"));
  console.log("invoke ping:", await evalAsync(ws, "window.__TAURI_INTERNALS__.invoke('ping', { message: 'e2e' })"));
  console.log("settings:", JSON.stringify(await evalAsync(ws, "window.__TAURI_INTERNALS__.invoke('settings_get')")));
  await sleep(300);
  try { process.kill(pid); console.log("killed app pid", pid); } catch (e) { console.log("kill:", e.message); }
  process.exit(0);
})().catch((e) => { console.error("smoke failed:", e); process.exit(1); });
