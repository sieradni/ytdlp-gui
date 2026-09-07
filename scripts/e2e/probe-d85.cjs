// d85 live probe (v2): waits for content before asserting
const path = require("path");
const { launchAndAttach, evalAsync, sleep } = require("./cdp.cjs");
process.env.YTDLP_GUI_DATA_DIR = path.join(process.env.APPDATA, "ytdlp-gui-dev");
(async () => {
  const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");
  const { ws } = await launchAndAttach(exe, 9333);
  await sleep(3500);
  const waitRows = async () => {
    for (let i = 0; i < 20; i++) {
      const n = await evalAsync(ws, `document.querySelectorAll('tr.qrow').length`);
      if (n > 0) return n;
      await sleep(500);
    }
    return 0;
  };
  const nRows = await waitRows();
  const r1 = await evalAsync(ws, `(() => {
    const rows = [...document.querySelectorAll('tr.qrow')];
    const sortBtn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('sort:'));
    return { count: rows.length, firstStatus: rows[0]?.dataset.status, sortLabel: sortBtn?.textContent?.trim() };
  })()`);
  console.log("ORDER:", JSON.stringify(r1));
  // flip order via # header, first row should change or stay active-pinned
  await evalAsync(ws, `(() => { const th = [...document.querySelectorAll('th')].find(t => t.textContent.includes('#')); th?.click(); return 1; })()`);
  await sleep(400);
  const r1b = await evalAsync(ws, `(() => {
    const rows = [...document.querySelectorAll('tr.qrow')];
    const sortBtn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('sort:'));
    return { firstStatus: rows[0]?.dataset.status, sortLabel: sortBtn?.textContent?.trim() };
  })()`);
  console.log("ORDER-FLIPPED:", JSON.stringify(r1b));
  // clear-all
  const before = nRows;
  await evalAsync(ws, `(() => { [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === 'clear all')?.click(); return 1; })()`);
  await sleep(1800);
  const after = await evalAsync(ws, `document.querySelectorAll('tr.qrow').length`);
  console.log("CLEARALL:", JSON.stringify({ before, after }));
  // dest persist: type into composer dest, then read settings store
  const r3 = await evalAsync(ws, `(async () => {
    const inp = document.querySelector('input[placeholder*="downloads"]');
    if (!inp) return 'NO-DEST-INPUT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, 'C:\\tmp\\d85-dest');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 800));
    const mod = await import('/src/stores/settings.ts');
    return { persisted: mod.useSettings.getState().settings.destination };
  })()`);
  console.log("DEST-PERSIST:", JSON.stringify(r3));
  process.exit(0);
})().catch(e => { console.error("PROBE-ERR", e.message); process.exit(1); });
