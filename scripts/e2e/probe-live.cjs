//! attach-only live probe: connect to an ALREADY-RUNNING app's debug port and
//! snapshot the state the S18 ↻-click predicate depends on, every 2s.
//! usage: node scripts/e2e/probe-live.cjs [port] [seconds]
const { WsClient, wireClient, httpJson, evalAsync, sleep } = require("./cdp.cjs");

const PORT = Number(process.argv[2] ?? 9333);
const SECONDS = Number(process.argv[3] ?? 60);

(async () => {
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      page = targets.find((t) => t.type === "page" && !/devtools/.test(t.url));
    } catch { /* not up yet */ }
    if (!page) await sleep(500);
  }
  if (!page) { console.log("no debug endpoint on :" + PORT); process.exit(1); }
  const ws = new WsClient(page.webSocketDebuggerUrl);
  wireClient(ws);
  await ws.connect();
  await ws.call("Runtime.enable");

  const SNAP = `(() => {
    const active = document.querySelector('.tab-btn.active')?.textContent.trim() ?? '?';
    const trs = [...document.querySelectorAll('.card table tbody tr')];
    const rows = trs.map(r => r.textContent.replace(/\\s+/g, ' ').slice(0, 140));
    const redl = trs.filter(r => [...r.querySelectorAll('button')].some(b => (b.title ?? '').startsWith('download again'))).length;
    const hasAWalk = document.body.innerHTML.includes('A Walk');
    const histErr = document.body.textContent.includes('no history yet');
    return JSON.stringify({ active, trs: trs.length, redl, hasAWalk, histErr, rows: rows.slice(0, 4) });
  })()`;

  for (let t = 0; t < SECONDS; t += 2) {
    let out;
    try { out = await evalAsync(ws, SNAP); } catch (e) { out = "eval-fail: " + e.message.slice(0, 80); }
    console.log(`t+${String(t).padStart(3)}s  ${out}`);
    await sleep(2000);
  }
  process.exit(0);
})();
