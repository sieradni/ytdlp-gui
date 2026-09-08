import json
import os
import sqlite3
import sys

sb = sys.argv[1]
old_dir = sys.argv[2]
url = sys.argv[3]

opts = {
    "dlType": "audio",
    "audioFormat": "best",
    "coverMode": "square",
    "coverW": 640,
    "coverH": 640,
    "maxResolution": "best",
    "container": "mp4",
    "audioPref": "opus",
    "playlistMode": "single",
    "playlistN": 10,
    "skipDownloaded": False,
    "overwrite": False,
    "cookies": {"kind": "none", "browser": None, "file": None},
    "subtitleLangs": [],
    "autoCaptions": False,
    "sponsorblock": [],
    "extraArgs": [],
    "outputTemplate": None,
    "url": url,
}
conn = sqlite3.connect(os.path.join(sb, "history.db"))
conn.execute(
    "INSERT INTO jobs (id, options, dest, state, title, format, final_path, vid,"
    " pct, speed_bps, eta_sec, error, skipped, items_done, items_total,"
    " created_at, updated_at)"
    " VALUES ('j-seed', ?, ?, 'stopped', 'Me at the zoo', NULL, NULL,"
    " 'jNQXAC9IVRw', NULL, NULL, NULL, 'stopped by user — partial files kept',"
    " 0, NULL, NULL, 1000, 1000)",
    (json.dumps(opts), old_dir),
)
conn.commit()
conn.close()
print("seeded j-seed into", sb)
