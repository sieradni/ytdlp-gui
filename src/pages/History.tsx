export default function HistoryPage() {
  return (
    <div className="mx-auto max-w-[860px] px-5 pt-4 pb-9">
      <div className="card">
        <div className="card-h">
          <h2>history</h2>
          <div className="flex items-center gap-2">
            <input type="text" placeholder="search title, channel, url…" style={{ width: 210 }} disabled />
            <button className="btn sm" disabled>
              search
            </button>
          </div>
        </div>
        <p className="hint" style={{ padding: "10px 12px" }}>
          history table arrives in m3 (sqlite).
        </p>
      </div>
    </div>
  );
}
