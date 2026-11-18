// Serves site/ locally with the cross-origin isolation headers firebase.json sets (shared wasm memory needs them).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("../site", import.meta.url).pathname);
const port = Number(process.env.PORT || 8721);
const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript", ".html": "text/html", ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };

http.createServer((req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  let file = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (file.endsWith("/")) file += "index.html";
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
  res.setHeader("Content-Length", fs.statSync(file).size);
  fs.createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
