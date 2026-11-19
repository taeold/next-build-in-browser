// In-memory file system shared by every wasm thread. Each client worker owns a MessagePort plus a
// SharedArrayBuffer pair; it posts a request and blocks in Atomics.wait until this worker answers.
// This worker never blocks, so it can serve threads that are themselves blocked inside wasm.
import { decompressed } from "./decompress.js";

const nodes = new Map(); // absolute path -> { kind: "file" | "dir", data, size, mode, mtimeMs, ino, children }
let nextIno = 1;
const fds = new Map(); // fd -> { path, flags, pos }
let nextFd = 100;
const stats = { calls: 0, byOp: {}, recent: [] };

const norm = (p) => {
  const out = [];
  for (const part of String(p).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
};
const parent = (p) => (p === "/" ? "/" : p.slice(0, p.lastIndexOf("/")) || "/");
const base = (p) => p.slice(p.lastIndexOf("/") + 1);
const err = (code, path) => Object.assign(new Error(`${code}: ${path}`), { code });

function addDir(p, mtimeMs = Date.now()) {
  if (nodes.has(p)) return nodes.get(p);
  const n = { kind: "dir", mode: 0o755, mtimeMs, ino: nextIno++, children: new Set() };
  nodes.set(p, n);
  if (p !== "/") addDir(parent(p)).children.add(base(p));
  return n;
}
function addFile(p, data, mode = 0o644, mtimeMs = Date.now()) {
  addDir(parent(p)).children.add(base(p));
  const n = { kind: "file", data, size: data.length, mode, mtimeMs, ino: nextIno++ };
  nodes.set(p, n);
  return n;
}
// Canonical path: symlinks in intermediate components are always followed; the last one only if followLast.
function resolve(path, followLast = true, depth = 0) {
  if (depth > 40) throw err("ELOOP", path);
  const parts = norm(path).split("/").filter(Boolean);
  let cur = "";
  for (let i = 0; i < parts.length; i++) {
    const next = cur + "/" + parts[i];
    const n = nodes.get(next);
    if (n && n.kind === "link" && (i < parts.length - 1 || followLast)) {
      cur = resolve(n.target.startsWith("/") ? n.target : (cur || "/") + "/" + n.target, true, depth + 1);
      if (cur === "/") cur = "";
    } else cur = next;
  }
  return cur || "/";
}
// Where a new entry named by `path` goes: its parent resolved, its own name left as is.
const resolveEntry = (path) => { const p = norm(path); if (p === "/") return "/"; const dir = resolve(parent(p)); return (dir === "/" ? "" : dir) + "/" + base(p); };
const get = (p, followLast = true) => {
  const n = nodes.get(resolve(p, followLast));
  if (!n) throw err("ENOENT", p);
  return n;
};

function statOf(n) {
  if ((n.kind === "file" && !Number.isFinite(n.size)) || !Number.isFinite(n.mtimeMs)) console.error(`FS NaN STAT: kind=${n.kind} size=${n.size} mtimeMs=${n.mtimeMs} recent=${JSON.stringify(stats.recent)}`);
  const type = n.kind === "dir" ? 0o040000 : n.kind === "link" ? 0o120000 : 0o100000;
  return { kind: n.kind, size: n.kind === "file" ? n.size : n.kind === "link" ? n.target.length : 4096, mode: type | n.mode, mtimeMs: n.mtimeMs, ino: n.ino };
}

const O_WRONLY = 1, O_RDWR = 2, O_CREAT = 64, O_EXCL = 128, O_TRUNC = 512, O_APPEND = 1024, O_DIRECTORY = 65536;
const flagBits = (f) => (typeof f === "number" ? f : { r: 0, "r+": O_RDWR, w: O_WRONLY | O_CREAT | O_TRUNC, "w+": O_RDWR | O_CREAT | O_TRUNC, a: O_WRONLY | O_CREAT | O_APPEND }[f] ?? 0);

function ensureCapacity(n, size) {
  if (n.data.length >= size) return;
  const grown = new Uint8Array(Math.max(size, n.data.length * 2, 4096));
  grown.set(n.data.subarray(0, n.size));
  n.data = grown;
}

const ops = {
  openSync(path, flags) {
    const p = resolve(path), f = flagBits(flags);
    let n = nodes.get(p);
    if (n && (f & O_CREAT) && (f & O_EXCL)) throw err("EEXIST", p);
    if (!n) {
      if (!(f & O_CREAT)) throw err("ENOENT", p);
      const dir = nodes.get(parent(p));
      if (!dir || dir.kind !== "dir") throw err("ENOENT", p);
      n = addFile(p, new Uint8Array(0));
    }
    if ((f & O_DIRECTORY) && n.kind !== "dir") throw err("ENOTDIR", p);
    if (n.kind === "dir" && (f & (O_WRONLY | O_RDWR))) throw err("EISDIR", p);
    if (n.kind === "file" && (f & O_TRUNC)) { n.size = 0; n.mtimeMs = Date.now(); }
    const fd = nextFd++;
    fds.set(fd, { path: p, flags: f, pos: 0 });
    return fd;
  },
  closeSync(fd) { fds.delete(fd); },
  fstatSync(fd) { const e = fds.get(fd); if (!e) throw err("EBADF", fd); return statOf(get(e.path)); },
  statSync(path) { return statOf(get(path)); },
  lstatSync(path) { return statOf(get(path, false)); },
  realpathSync(path) { get(path); return resolve(path); },
  readlinkSync(path) { const n = get(path, false); if (n.kind !== "link") throw err("EINVAL", path); return n.target; },
  readdirSync(path) {
    const p = resolve(path), n = nodes.get(p);
    if (!n) throw err("ENOENT", path);
    if (n.kind !== "dir") throw err("ENOTDIR", path);
    return [...n.children].map((name) => ({ name, kind: nodes.get((p === "/" ? "" : p) + "/" + name).kind }));
  },
  mkdirSync(path) {
    const p = resolveEntry(path);
    if (nodes.has(p)) throw err("EEXIST", p);
    if (!nodes.has(parent(p))) throw err("ENOENT", p);
    addDir(p);
  },
  rmdirSync(path) {
    const p = resolveEntry(path), n = get(p, false);
    if (n.kind !== "dir") throw err("ENOTDIR", p);
    if (n.children.size) throw err("ENOTEMPTY", p);
    nodes.delete(p); nodes.get(parent(p))?.children.delete(base(p));
  },
  unlinkSync(path) {
    const p = resolveEntry(path), n = get(p, false);
    if (n.kind === "dir") throw err("EISDIR", p);
    nodes.delete(p); nodes.get(parent(p))?.children.delete(base(p));
  },
  renameSync(from, to) {
    const a = resolveEntry(from), b = resolveEntry(to);
    get(a, false);
    if (!nodes.has(parent(b))) throw err("ENOENT", b);
    const moved = [...nodes.keys()].filter((k) => k === a || k.startsWith(a + "/"));
    const entries = moved.map((k) => [k, nodes.get(k)]);
    for (const [k] of entries) nodes.delete(k);
    nodes.get(parent(a))?.children.delete(base(a));
    for (const [k, n] of entries) nodes.set(b + k.slice(a.length), n);
    nodes.get(parent(b)).children.add(base(b));
  },
  ftruncateSync(fd, len = 0) { const n = get(fds.get(fd).path); ensureCapacity(n, len); if (len > n.size) n.data.fill(0, n.size, len); n.size = len; },
  utimesSync(path, atime, mtime) { get(path).mtimeMs = Number(mtime) * 1000; },
  futimesSync(fd, atime, mtime) { get(fds.get(fd).path).mtimeMs = Number(mtime) * 1000; },
  fsyncSync() {}, fdatasyncSync() {},
  symlinkSync(target, path) {
    const p = resolveEntry(path);
    if (nodes.has(p)) throw err("EEXIST", path);
    const dir = nodes.get(parent(p));
    if (!dir || dir.kind !== "dir") throw err("ENOENT", path);
    nodes.set(p, { kind: "link", target: String(target), mode: 0o777, mtimeMs: Date.now(), ino: nextIno++ });
    dir.children.add(base(p));
  },
  linkSync(a, b) { throw err("EPERM", b); },
};

function readInto(fd, length, position, out) {
  const e = fds.get(fd);
  if (!e) throw err("EBADF", fd);
  const n = get(e.path);
  if (n.kind !== "file") throw err("EISDIR", e.path);
  const at = position == null || position < 0 ? e.pos : position;
  const count = Math.max(0, Math.min(length, n.size - at, out.length));
  out.set(n.data.subarray(at, at + count));
  if (position == null || position < 0) e.pos = at + count;
  return count;
}
function writeFrom(fd, bytes, position) {
  const e = fds.get(fd);
  if (!e) throw err("EBADF", fd);
  const n = get(e.path);
  const at = e.flags & O_APPEND ? n.size : position == null || position < 0 ? e.pos : position;
  ensureCapacity(n, at + bytes.length);
  n.data.set(bytes, at);
  n.size = Math.max(n.size, at + bytes.length);
  n.mtimeMs = Date.now();
  if (position == null || position < 0) e.pos = at + bytes.length;
  return bytes.length;
}

function serve(port) {
  let ctrl, buf;
  const enc = new TextEncoder();
  port.onmessage = ({ data }) => {
    if (data.hello) { ({ ctrl, buf } = data.hello); return; }
    const { op, args, id } = data;
    stats.calls++; stats.byOp[op] = (stats.byOp[op] || 0) + 1;
    stats.recent.push(op + " " + (typeof args[0] === "string" ? args[0] : JSON.stringify(args[0]))); if (stats.recent.length > 8) stats.recent.shift();
    let status = 0, len = 0;
    try {
      if (op === "readSync") len = readInto(args[0], args[1], args[2], buf);
      else if (op === "writeSync") len = writeFrom(args[0], args[1], args[2]);
      else if (op === "readFileBytes") { const n = get(args[0]); if (n.size > buf.length) throw err("EFBIG", args[0]); buf.set(n.data.subarray(0, n.size)); len = n.size; }
      else if (op === "writeFileBytes") { const p = resolve(args[0]); const n = nodes.get(p) || addFile(p, new Uint8Array(0)); n.data = args[1]; n.size = args[1].length; n.mtimeMs = Date.now(); }
      else if (op === "stats") { const b = enc.encode(JSON.stringify(stats)); buf.set(b); len = b.length; status = 2; }
      else {
        const fn = ops[op];
        if (!fn) throw err("ENOSYS", op);
        const b = enc.encode(JSON.stringify(fn(...args) ?? null));
        if (b.length > buf.length) throw err("E2BIG", op);
        buf.set(b); len = b.length; status = 2;
      }
    } catch (e) {
      const b = enc.encode(JSON.stringify({ code: e.code || "EIO", message: e.message }));
      buf.set(b); len = b.length; status = 1;
    }
    Atomics.store(ctrl, 3, id | 0);
    Atomics.store(ctrl, 1, status);
    Atomics.store(ctrl, 2, len);
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
  };
}

addDir("/"); // WASI preopens "/" as soon as the build host starts, possibly before any pack has loaded

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  const total = Number(res.headers.get("content-length")) || 0;
  let seen = 0;
  const counted = res.body.pipeThrough(new TransformStream({ transform(chunk, c) { seen += chunk.length; onProgress(seen, total); c.enqueue(chunk); } }));
  const body = decompressed(counted, url);
  return new Uint8Array(await new Response(body).arrayBuffer());
}
function mountPack(bytes) {
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen)));
  const start = 4 + headerLen;
  for (const d of header.dirs || []) addDir(d);
  for (const [p, off, len, mode, mtimeMs] of header.files) addFile(p, bytes.subarray(start + off, start + off + len), mode || 0o644, mtimeMs || Date.now());
  return header.files.length;
}

// Packs mount at the paths in their headers; each of `files` ([url, path]) becomes one file. All download at once.
async function load({ packs = [], files: fileList = [] }) {
  const progress = new Map();
  const report = (url) => (seen, total) => {
    progress.set(url, [seen, total]);
    let s = 0, t = 0; for (const [a, b] of progress.values()) { s += a; t += b; }
    self.postMessage({ type: "progress", seen: s, total: t });
  };
  const [packBytes, singles] = await Promise.all([
    Promise.all(packs.map((url) => fetchBytes(url, report(url)))),
    Promise.all(fileList.map(([url]) => fetchBytes(url, report(url)))),
  ]);
  let files = 0;
  for (const bytes of packBytes) files += mountPack(bytes);
  fileList.forEach(([, path], i) => { addFile(norm(path), singles[i], 0o644, Date.now()); files++; });
  return files;
}
// Every file under dir as [path relative to `base`, bytes, link target]. Symlinks stay symlinks: Turbopack links
// server externals as .next/node_modules/<pkg>-<hash> -> ../../node_modules/<pkg>.
function readTree(dir, base, out = []) {
  for (const name of [...nodes.get(dir).children].sort()) {
    const p = dir + "/" + name, n = nodes.get(p);
    if (n.kind === "link") out.push([p.slice(base.length + 1), new TextEncoder().encode(n.target), n.target]);
    else if (n.kind === "dir") readTree(p, base, out);
    else out.push([p.slice(base.length + 1), n.data.slice(0, n.size)]);
  }
  return out;
}

self.onmessage = async ({ data }) => {
  if (data.type === "load") {
    const files = await load(data);
    for (const d of data.extraDirs || []) addDir(d);
    self.postMessage({ type: "loaded", id: data.id, files });
  } else if (data.type === "writeFiles") {
    for (const [p, bytes] of data.files) addFile(norm(p), bytes);
    self.postMessage({ type: "written", count: data.files.length });
  } else if (data.type === "readTree") {
    // The first of `dirs` that exists (and holds `marker`, if given) under `base`.
    const found = data.dirs.find(([d, marker]) => nodes.get(norm(data.base + "/" + d))?.kind === "dir" && (!marker || nodes.has(norm(`${data.base}/${d}/${marker}`))));
    const files = found ? readTree(norm(data.base + "/" + found[0]), norm(data.base)) : [];
    self.postMessage({ type: "tree", dir: found && found[0], files }, files.map(([, b]) => b.buffer));
  } else if (data.type === "registrar") {
    listenRegistrar(data.port);
  }
};

// A registrar port lets a worker hand this worker new client ports (and new registrars) for the threads it spawns.
function listenRegistrar(port) {
  port.onmessage = ({ data }) => {
    if (data.type === "register") serve(data.port);
    else if (data.type === "registrar") listenRegistrar(data.port);
  };
}
