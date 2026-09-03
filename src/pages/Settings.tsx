export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-[860px] px-5 pt-4 pb-9">
      <div className="card">
        <div className="card-h">
          <h2>tools</h2>
          <span className="hint">autosave — changes apply instantly</span>
        </div>
        <p className="hint" style={{ padding: "10px 12px" }}>
          tool management arrives in m2.
        </p>
      </div>
      <div className="card">
        <div className="card-h">
          <h2>downloads</h2>
        </div>
        <p className="hint" style={{ padding: "10px 12px" }}>
          download settings arrive in m3.
        </p>
      </div>
      <div className="card">
        <div className="card-h">
          <h2>app</h2>
        </div>
        <div className="card-b fgrid">
          <label>version</label>
          <div className="flex items-center gap-2">
            <span className="numm">v2.0.0-alpha.1</span>
            <span className="hint">ytdlp-gui · windows x64</span>
          </div>
          <label>license</label>
          <div className="flex items-center">
            <span className="hint">unlicense — do whatever</span>
          </div>
        </div>
      </div>
    </div>
  );
}
