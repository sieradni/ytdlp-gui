// drive the installed (upgraded) app over cdp: verify version + run the d69
// artifact cleanup on the genuinely contaminated alpha.2 profile.
const path = require("path");
const { WsClient, wireClient, sleep } = require(path.resolve(__dirname, "cdp.cjs"));

async function main() {
  const targets = await fetch("http://127.0.0.1:9344/json/list").then((r) => r.json());
  const page = targets.find((t) => t.type === "page" && !/devtools/.test(t.url));
  if (!page) throw new Error("no page target");
  const ws = new WsClient(page.webSocketDebuggerUrl);
  wireClient(ws);
  await ws.connect();
  await ws.call("Runtime.enable");
  await sleep(1000);

  const evalJson = async (expr) => {
    const r = await ws.call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };

  const hasTauri = await evalJson(`!!window.__TAURI_INTERNALS__`);
  console.log("tauri internals:", hasTauri);

  const ver = await evalJson(`window.__TAURI_INTERNALS__.invoke('app_version')`);
  console.log("app_version:", JSON.stringify(ver));

  const report = await evalJson(`window.__TAURI_INTERNALS__.invoke('e2e_artifacts_report')`);
  console.log("artifact report: jobs=" + report.jobs.length + " history=" + report.history.length);
  console.log("sample:", JSON.stringify(report.jobs.slice(0, 2)));
  console.log("hist sample:", JSON.stringify(report.history.slice(0, 2)));

  const rem = await evalJson(`window.__TAURI_INTERNALS__.invoke('e2e_artifacts_remove')`);
  console.log("removed:", JSON.stringify(rem));

  const report2 = await evalJson(`window.__TAURI_INTERNALS__.invoke('e2e_artifacts_report')`);
  console.log("report after: jobs=" + report2.jobs.length + " history=" + report2.history.length);

  ws.close?.();
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
