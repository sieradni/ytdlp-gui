export default function HomePage() {
  return (
    <div className="mx-auto max-w-[860px] px-5 pt-4 pb-9">
      <div className="card">
        <div className="card-h">
          <h2>add downloads</h2>
          <span className="hint">one url per line · playlists expand</span>
        </div>
        <div className="card-b">
          <p className="hint">composer arrives in m3 — shell only for m1.</p>
        </div>
      </div>
      <div className="card">
        <div className="card-h">
          <h2>queue</h2>
        </div>
        <div className="qwrap flex flex-col" style={{ height: 400 }}>
          <p className="hint" style={{ padding: "10px 12px" }}>
            queue table arrives in m3.
          </p>
        </div>
      </div>
    </div>
  );
}
