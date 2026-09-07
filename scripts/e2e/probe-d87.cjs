// d87: archive entry removal through the real ui
const path = require("path");
const { launchAndAttach, evalAsync, sleep } = require("./cdp.cjs");
process.env.YTDLP_GUI_DATA_DIR = path.join(process.env.APPDATA, "ytdlp-gui-dev");
(async () => {
  const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");
  const { ws } = await launchAndAttach(exe, 9342);
  await sleep(4000);
  // navigate to history
  await evalAsync(ws, `(() => { [...document.querySelectorAll('button,.tab-btn')].find(b => (b.textContent||'').trim() === 'history')?.click(); return 1; })()`);
  await sleep(1200);
  // need a history row for youtube jNQXAC9IVRw — backfill it from the archive via sync
  await evalAsync(ws, `(() => { [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('sync history from archive'))?.click(); return 1; })()`);
  await sleep(1500);
  // find the row and click its ✕
  const r1 = await evalAsync(ws, `(() => {
    const rows = [...document.querySelectorAll('tr')];
    const row = rows.find(r => r.querySelector('.t-meta')?.textContent.includes('jNQXAC9IVRw'));
    if (!row) return 'NO-ROW';
    const btn = [...row.querySelectorAll('button')].find(b => (b.title||'').startsWith('remove from archive'));
    if (!btn) return 'NO-BUTTON';
    btn.click();
    return 'CLICKED';
  })()`);
  console.log("CLICK-X:", JSON.stringify(r1));
  await sleep(700);
  // confirm dialog — click "remove"
  const r2 = await evalAsync(ws, `(() => {
    const dlg = document.querySelector('[data-cdlg], .cdlg-overlay, [class*=dialog]');
    if (!dlg) return 'NO-DIALOG';
    const btns = [...dlg.querySelectorAll('button')].map(b => b.textContent.trim());
    const rm = [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === 'remove');
    if (!rm) return { buttons: btns };
    rm.click();
    return 'CONFIRMED';
  })()`);
  console.log("CONFIRM:", JSON.stringify(r2));
  await sleep(900);
  // read the archive file + feedback message
  const r3 = await evalAsync(ws, `(async () => {
    const msg = document.querySelector('.hist-msg')?.textContent ?? null;
    const mod = await import('/src/lib/ipc.ts');
    const p = await mod.appPaths();
    return { msg, archivePath: p.archivePath };
  })()`);
  console.log("RESULT:", JSON.stringify(r3));
  process.exit(0);
})().catch(e => { console.error("PROBE-ERR", e.message); process.exit(1); });
