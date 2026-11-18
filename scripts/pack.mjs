// Packs directories into one gzipped archive the in-tab file system mounts at chosen absolute paths.
// Format: u32 header length, JSON header {files: [[path, offset, length, mode]]}, then the file bytes.
// Compressed with brotli (OUT.br) or gzip (OUT.gz).
// Usage: node scripts/pack.mjs OUT.pack.br DIR=/mount/path [DIR=/mount/path ...]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { compress } from "./compress.mjs";

const [out, ...mounts] = process.argv.slice(2);
const entries = [], chunks = [];
let offset = 0;
for (const spec of mounts) {
  const [dir, mount] = spec.split("=");
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const bytes = fs.readFileSync(p);
        entries.push([mount.replace(/\/$/, "") + "/" + path.relative(dir, p), offset, bytes.length, fs.statSync(p).mode & 0o777]);
        chunks.push(bytes);
        offset += bytes.length;
      }
    }
  };
  walk(dir);
}
const header = Buffer.from(JSON.stringify({ files: entries }));
const len = Buffer.alloc(4);
len.writeUInt32LE(header.length);
fs.writeFileSync(out, compress(Buffer.concat([len, header, ...chunks]), out));
console.log(`${out}: ${entries.length} files, ${(offset / 1048576).toFixed(0)} MiB raw, ${(fs.statSync(out).size / 1048576).toFixed(0)} MiB compressed`);
