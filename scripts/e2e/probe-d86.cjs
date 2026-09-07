// d86: cookies persist across relaunch + unicode title job completes
const path = require("path");
const fs = require("fs");
const { launchAndAttach, evalAsync, sleep } = require("./cdp.cjs");
const dataDir = path.join(process.env.APPDATA, "ytdlp-gui-dev");
process.env.YTDLP_GUI_DATA_DIR = dataDir;
(async () => {
  // clean slate for determinism (keep bin/)
  for (const f of ["settings.json", "history.db", "downloaded.txt"]) {
    try { fs.unlinkSync(path.join(dataDir, f)); } catch {}
  }
  const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");

  // ---- session 1: open advanced, select cookies → from browser (firefox)
  const s1 = await launchAndAttach(exe, 9340);
  await sleep(4000);
  const r1 = await evalAsync(s1.ws, `(async () => {
    const adv = [...document.querySelectorAll('button')].find(b => /advanced/i.test(b.textContent||''));
    if (adv) adv.click();
    await new Promise(r => setTimeout(r, 300));
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'frombrowser'));
    if (!sel) return 'NO-SELECT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'frombrowser');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    return 'SET';
  })()`);
  console.log("SET-COOKIES:", JSON.stringify(r1));
  await sleep(500);
  s1.ws.close?.();
  process.exit; // keep process alive pattern below
  // give the async save a beat, then read disk
  await sleep(1200);
  const settings1 = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
  console.log("DISK-AFTER-SET:", JSON.stringify({ kind: settings1.composeOpts?.cookies?.kind, browser: settings1.composeOpts?.cookies?.browser }));
  try { s1.child.kill(); } catch {}
  await sleep(1500);

  // ---- session 2: relaunch — cookies must be pre-selected WITHOUT touching anything
  const s2 = await launchAndAttach(exe, 9341);
  await sleep(4000);
  const r2 = await evalAsync(s2.ws, `(async () => {
    const adv = [...document.querySelectorAll('button')].find(b => /advanced/i.test(b.textContent||''));
    if (adv) adv.click();
    await new Promise(r => setTimeout(r, 300));
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'frombrowser'));
    return sel ? sel.value : 'NO-SELECT';
  })()`);
  console.log("AFTER-RELAUNCH:", JSON.stringify(r2));
  // queue the unicode-title video exactly like the user would (enter in url box)
  const r3 = await evalAsync(s2.ws, `(async () => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'NO-TEXTAREA';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'https://www.youtube.com/watch?v=KD1DE1dalok');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const btn = [...document.querySelectorAll('button')].find(b => /queue/i.test(b.textContent||'') && !/clear|downloaded/.test(b.textContent||''));
    if (btn) { btn.click(); return 'CLICKED'; }
    return 'NO-BUTTON';
  })()`);
  console.log("QUEUE:", JSON.stringify(r3));
  // poll until terminal (done/duplicate/error/stopped) or 120s
  let final = null;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await evalAsync(s2.ws, `(() => {
      const r = document.querySelector('tr.qrow');
      return r ? { status: r.dataset.status, title: r.querySelector('.t-title')?.textContent?.slice(0,40), meta: r.querySelector('.t-meta')?.textContent?.slice(0,60) } : null;
    })()`);
    if (st && ['done','error','duplicate','stopped'].includes(st.status)) { final = st; break; }
    if (st) final = st;
  }
  console.log("FINAL:", JSON.stringify(final));
  const hist = await evalAsync(s2.ws, `(async () => {
    const mod = await import('/src/lib/ipc.ts');
    const rows = await mod.historyList();
    const row = rows.find(x => (x.finalPath||'').includes('KD1DE1') || (x.title||'').includes('キミ'));
    return row ? { title: row.title, finalPath: row.finalPath, format: row.format, size: row.sizeBytes } : rows.length ? rows[0] : 'EMPTY';
  })()`);
  console.log("HISTORY:", JSON.stringify(hist));
  try { s2.child.kill(); } catch {}
  process.exit(0);
})().catch(e => { console.error("PROBE-ERR", e.message); process.exit(1); });
