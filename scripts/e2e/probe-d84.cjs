const path = require("path");
const { launchAndAttach, evalAsync, sleep } = require("./cdp.cjs");
process.env.YTDLP_GUI_PROFILE = "sandbox";
(async () => {
  const exe = path.resolve(__dirname, "../../src-tauri/target/debug/ytdlp-gui.exe");
  const { ws } = await launchAndAttach(exe, 9333);
  await sleep(2500);
  // 1) cookies trap: select "from browser…", read the preview tokens
  const r1 = await evalAsync(ws, `(async () => {
    const adv = [...document.querySelectorAll('button,summary,[role=button],.adv-toggle')].find(b => /advanced/i.test(b.textContent||''));
    if (adv) adv.click();
    await new Promise(r => setTimeout(r, 250));
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'frombrowser'));
    if (!sel) return 'NO-COOKIE-SELECT';
    sel.value = 'frombrowser';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const bsel = [...document.querySelectorAll('select')].find(s => ['firefox','chrome','edge'].includes(s.value));
    const preview = document.querySelector('.cmdprev, [class*=preview]')?.textContent ?? '';
    return { browserSelectValue: bsel ? bsel.value : null, previewHasFlag: preview.includes('--cookies-from-browser'), previewSnippet: preview.slice(0, 220) };
  })()`);
  console.log("COOKIES:", JSON.stringify(r1));
  // 2) hovercard dwell: mouseover a row's text cell, card must NOT appear at 400ms, must at 900ms; crossing another cell must not trigger
  const r2 = await evalAsync(ws, `(async () => {
    const rows = [...document.querySelectorAll('tr.qrow')];
    if (!rows.length) return 'NO-ROWS';
    const cell = rows[0].querySelector('td:nth-child(2)');
    if (!cell) return 'NO-CELL';
    cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const early = !!document.querySelector('.hovercard-shown');
    await new Promise(r => setTimeout(r, 500));
    const late = !!document.querySelector('.hovercard-shown');
    // other-cell crossing: idx cell
    const idx = rows[0].querySelector('td.idx');
    idx.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    idx.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    await new Promise(r => setTimeout(r, 800));
    const afterIdx = !!document.querySelector('.hovercard-shown');
    return { appearedAt400ms: early, appearedAfter700ms: late, idxCellTriggers: afterIdx };
  })()`);
  console.log("HOVERCARD:", JSON.stringify(r2));
  process.exit(0);
})().catch(e => { console.error("PROBE-ERR", e.message); process.exit(1); });
