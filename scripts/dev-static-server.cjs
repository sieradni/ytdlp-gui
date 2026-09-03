// Minimal static server for previewing dist/app in a plain browser.
// Not part of the app; used only for visual checks during development.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2] || path.join(__dirname, "..", "dist", "app");
const port = Number(process.argv[3] || 4176);

const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

http
  .createServer((req, res) => {
    let url = decodeURIComponent(req.url.split("?")[0]);
    if (url.endsWith("/")) url += "index.html";
    const fp = path.join(root, url);
    if (!fp.startsWith(root)) {
      res.statusCode = 403;
      return res.end("forbidden");
    }
    fs.readFile(fp, (err, data) => {
      if (err) {
        res.statusCode = 404;
        return res.end("not found");
      }
      res.setHeader("content-type", mime[path.extname(fp)] || "application/octet-stream");
      res.end(data);
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
