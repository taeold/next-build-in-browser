// Just enough Node.js for `next build --experimental-build-mode compile` in a worker: a CommonJS loader with
// Node's Module shape (Next's require-hook patches Module._resolveFilename), `import()` routed through it, and a
// registry of built-ins. Files come from fs-client.js; most built-ins are browserify-era polyfills.

const BUILTIN_NAMES = [
  "assert", "async_hooks", "buffer", "child_process", "console", "constants", "crypto", "diagnostics_channel", "dns", "dns/promises",
  "events", "fs", "fs/promises", "http", "http2", "https", "inspector", "module", "net", "os", "path", "path/posix", "path/win32",
  "perf_hooks", "process", "punycode", "querystring", "readline", "stream", "stream/promises", "stream/web", "string_decoder",
  "timers", "timers/promises", "tls", "tty", "url", "util", "util/types", "v8", "vm", "wasi", "worker_threads", "zlib",
];

// `worker` ({ workerData, threadId, port }) makes this runtime a worker thread; `port` is its link to its parent.
let nextThreadId = 0;
// Shared by every runtime in this realm, so the host recognizes an exit thrown from any of them.
class ProcessExit extends Error { constructor(code) { super(`process.exit(${code})`); this.code = code; } }
// `redirects` maps a package name to another specifier or an absolute path (for stand-ins of native packages).
// `transformEsm(source, filename)` compiles an ES module to CommonJS, so require() of ESM works as in Node 22+.
import { WASI as WasmUtilWASI } from "/wasm-util.js";

// `spawnWorker(init, transfer)` starts a real thread (a Web Worker running node-worker.js) for worker_threads.Worker and
// returns the MessagePort linked to it.
export function createRuntime({ fs: fsc, env, argv, cwd, polyfills, write, worker = null, redirects = {}, transformEsm = null, spawnWorker = null }) {
  const builtins = new Map();
  const factories = {};
  // What would keep a Node process alive, shared by every runtime on this thread (they share globals): referenced
  // timers, immediates, MessagePorts and worker threads. whenIdle() resolves once nothing does.
  const loop = globalThis.__vvLoop || (globalThis.__vvLoop = { refs: new Set(), listeners: new Set(), setTimeout: null });
  const hold = (h) => { loop.refs.add(h); };
  const release = (h) => { if (loop.refs.delete(h)) for (const f of [...loop.listeners]) f(); };
  const builtinSet = new Set(BUILTIN_NAMES);
  const isBuiltin = (id) => builtinSet.has(id.startsWith("node:") ? id.slice(5) : id);

  // ---------- path helpers (posix only) ----------
  const normalize = (p) => {
    const abs = p.startsWith("/"), out = [];
    for (const part of p.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); }
      else out.push(part);
    }
    return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
  };
  const dirname = (p) => { const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };
  const join = (...a) => normalize(a.join("/"));
  const exists = (p) => { try { fsc.statSync(p); return true; } catch { return false; } };
  const isFile = (p) => { try { return fsc.statSync(p).isFile(); } catch { return false; } };
  const isDir = (p) => { try { return fsc.statSync(p).isDirectory(); } catch { return false; } };
  const readText = (p) => new TextDecoder().decode(readBytes(p));
  function readBytes(p) {
    const st = fsc.statSync(p);
    if (st.size < (15 << 20)) return fsc.readFileBytes(p);
    const out = new Uint8Array(st.size), fd = fsc.openSync(p, "r");
    try { fsc.readSync(fd, out, 0, st.size, 0); } finally { fsc.closeSync(fd); }
    return out;
  }

  // ---------- process ----------
  let EventEmitter; // filled once the events polyfill loads
  let processObj;
  function makeProcess() {
    const EE = loadBuiltin("events");
    const p = Object.assign(new EE(), {
      env, argv, execArgv: [], execPath: "/usr/bin/node", argv0: "node", title: "node", pid: 1, ppid: 0,
      platform: "linux", arch: "x64", version: "v24.0.0", versions: { node: "24.0.0", v8: "13.0", uv: "1.0", modules: "137" },
      release: { name: "node" }, config: { variables: {} }, features: {}, exitCode: undefined, connected: false,
      cwd: () => cwd, chdir: (d) => { cwd = normalize(d.startsWith("/") ? d : join(cwd, d)); },
      umask: () => 0o22, getuid: () => 0, getgid: () => 0, geteuid: () => 0, uptime: () => performance.now() / 1000,
      hrtime: Object.assign((prev) => {
        const ns = BigInt(Math.round(performance.now() * 1e6)); const s = Number(ns / 1000000000n), n = Number(ns % 1000000000n);
        if (!prev) return [s, n];
        let ds = s - prev[0], dn = n - prev[1]; if (dn < 0) { ds--; dn += 1e9; } return [ds, dn];
      }, { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
      memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), { rss: () => 0 }),
      cpuUsage: () => ({ user: 0, system: 0 }), resourceUsage: () => ({}),
      nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
      emitWarning: (w) => write(2, `(warning) ${w && w.message ? w.message : w}\n`),
      binding: () => ({}), _getActiveHandles: () => [], _getActiveRequests: () => [],
      exit: (code) => { p.exitCode = code ?? p.exitCode ?? 0; p.emit("exit", p.exitCode); throw new ProcessExit(p.exitCode); },
      kill: () => true, abort: () => { throw new Error("process.abort()"); },
      setUncaughtExceptionCaptureCallback() {}, hasUncaughtExceptionCaptureCallback: () => false,
    });
    p.setMaxListeners(0);
    processObj = p; globalThis.process = p; // the stream polyfill reads the global process while loading
    // Real streams: ora and friends pipe into stdout and listen on stdin.
    const { Writable, Readable } = loadBuiltin("stream");
    const out = (fd) => Object.assign(new Writable({ write(chunk, _e, cb) { write(fd, typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); cb(); } }), { isTTY: false, columns: 120, rows: 40, fd, _handle: null, getColorDepth: () => 1, hasColors: () => false, cursorTo() { return true; }, moveCursor() { return true; }, clearLine() { return true; }, getWindowSize: () => [120, 40] });
    p.stdout = out(1); p.stderr = out(2);
    p.stdin = Object.assign(new Readable({ read() {} }), { isTTY: false, fd: 0, setRawMode() { return this; }, ref() { return this; }, unref() { return this; } });
    return p;
  }

  // ---------- module loader ----------
  class Module {
    constructor(id = "", parent) { this.id = id; this.filename = id; this.exports = {}; this.loaded = false; this.children = []; this.parent = parent; this.paths = Module._nodeModulePaths(dirname(id || cwd)); }
    require(id) { return Module._load(id, this, false); }
    _compile(content, filename) { return compileModule(this, content, filename); }
    static _nodeModulePaths(from) {
      const out = []; let d = normalize(from);
      for (;;) { if (!d.endsWith("/node_modules")) out.push(join(d, "node_modules")); if (d === "/") break; d = dirname(d); }
      return out;
    }
    static _resolveFilename(request, parent) { return resolve(request, parent ? dirname(parent.filename || join(cwd, "x")) : cwd, parent); }
    static _load(request, parent) {
      for (const [from, to] of Object.entries(redirects)) if (request === from || request.startsWith(from + "/")) { request = to + request.slice(from.length); break; }
      if (isBuiltin(request)) return loadBuiltin(request);
      const filename = Module._resolveFilename(request, parent, false);
      if (isBuiltin(filename)) return loadBuiltin(filename);
      const cached = Module._cache[filename];
      if (cached) return cached.exports;
      const m = new Module(filename, parent);
      Module._cache[filename] = m;
      if (parent && parent.children) parent.children.push(m);
      try { m.load(filename); } catch (e) { delete Module._cache[filename]; throw e; }
      return m.exports;
    }
    load(filename) {
      const ext = filename.endsWith(".json") ? ".json" : filename.endsWith(".node") ? ".node" : ".js";
      Module._extensions[ext](this, filename);
      this.loaded = true;
    }
    static createRequire(from) {
      const f = String(from).startsWith("file:") ? decodeURIComponent(new URL(from).pathname) : String(from);
      const m = new Module(f.endsWith("/") ? join(f, "noop.js") : f); return makeRequire(m);
    }
    static isBuiltin(id) { return isBuiltin(id); }
  }
  Module._cache = Object.create(null);
  Module._extensions = {
    ".js": (m, filename) => m._compile(readText(filename), filename),
    ".json": (m, filename) => { m.exports = JSON.parse(readText(filename)); },
    ".node": (m, filename) => { throw Object.assign(new Error(`Cannot load native addon ${filename} in the browser`), { code: "ERR_DLOPEN_FAILED" }); },
  };
  Module.builtinModules = BUILTIN_NAMES.slice();
  Module.Module = Module;
  Module.wrap = (s) => `(function (exports, require, module, __filename, __dirname) { ${s}\n});`;
  Module.register = () => {}; Module.enableCompileCache = () => ({}); Module.syncBuiltinESMExports = () => {};
  Module.findSourceMap = () => undefined; Module.SourceMap = class {};

  function makeRequire(m) {
    const req = (id) => m.require(id);
    req.resolve = (id, opts) => {
      if (isBuiltin(id)) return id;
      if (opts && opts.paths) {
        for (const base of opts.paths) { try { return resolve(id, base, m); } catch {} }
        throw notFound(id, m);
      }
      return Module._resolveFilename(id, m, false, opts);
    };
    req.resolve.paths = (id) => (isBuiltin(id) ? null : Module._nodeModulePaths(dirname(m.filename || cwd)));
    req.cache = Module._cache; req.main = mainModule; req.extensions = Module._extensions;
    return req;
  }
  let mainModule;

  const notFound = (id, parent) => Object.assign(new Error(`Cannot find module '${id}'${parent && parent.filename ? `\nRequire stack:\n- ${parent.filename}` : ""}`), { code: "MODULE_NOT_FOUND" });
  const pkgCache = new Map();
  const readPkg = (dir) => {
    if (pkgCache.has(dir)) return pkgCache.get(dir);
    let pkg = null; const f = join(dir, "package.json");
    if (isFile(f)) { try { pkg = JSON.parse(readText(f)); } catch { pkg = null; } }
    pkgCache.set(dir, pkg); return pkg;
  };
  const CONDITIONS = ["node", "require", "default"];
  function resolveExportsTarget(target, subpathRest) {
    if (typeof target === "string") return target.replace(/\*/g, subpathRest);
    if (Array.isArray(target)) { for (const t of target) { const r = resolveExportsTarget(t, subpathRest); if (r) return r; } return null; }
    if (target && typeof target === "object") {
      for (const [k, v] of Object.entries(target)) if (CONDITIONS.includes(k)) { const r = resolveExportsTarget(v, subpathRest); if (r) return r; }
    }
    return null;
  }
  function resolveExports(pkgDir, exportsField, subpath) {
    let map = exportsField;
    // Shorthand exports (a target or condition map, not subpaths) become { ".": ... }. "imports" keys start with "#".
    if (typeof map === "string" || Array.isArray(map) || (map && !Object.keys(map).some((k) => k.startsWith(".") || k.startsWith("#")))) map = { ".": map };
    if (map[subpath] !== undefined) { const t = resolveExportsTarget(map[subpath], ""); return t ? join(pkgDir, t) : null; }
    for (const key of Object.keys(map)) {
      const star = key.indexOf("*");
      if (star < 0) continue;
      const pre = key.slice(0, star), post = key.slice(star + 1);
      if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= key.length - 1) {
        const t = resolveExportsTarget(map[key], subpath.slice(pre.length, subpath.length - post.length));
        return t ? join(pkgDir, t) : null;
      }
    }
    return null;
  }
  const EXTS = ["", ".js", ".json", ".cjs", ".node"];
  function tryFile(p) { for (const e of EXTS) if (isFile(p + e)) return p + e; return null; }
  // Polyfill packages (and only those) resolve with their `browser` field, like a browser bundler would.
  const underPolyfills = (p) => p.startsWith(polyfills + "/");
  function browserMap(pkgDir, file) {
    const pkg = readPkg(pkgDir);
    if (!pkg || !pkg.browser || typeof pkg.browser !== "object") return file;
    const rel = "./" + file.slice(pkgDir.length + 1);
    for (const [from, to] of Object.entries(pkg.browser)) {
      const f = from.startsWith("./") ? from : "./" + from;
      if ((f === rel || f + ".js" === rel || f === rel.replace(/\.js$/, "")) && typeof to === "string") return join(pkgDir, to);
    }
    return file;
  }
  function packageDirOf(file) { let d = dirname(file); for (;;) { if (readPkg(d)) return d; if (d === "/" || d === polyfills) return null; d = dirname(d); } }
  function tryDir(p) {
    const pkg = readPkg(p);
    if (pkg && underPolyfills(p) && typeof pkg.browser === "string") { const b = tryFile(join(p, pkg.browser)); if (b) return b; }
    if (pkg && pkg.main) { const m = tryFile(join(p, pkg.main)) || tryIndex(join(p, pkg.main)); if (m) return underPolyfills(p) ? browserMap(p, m) : m; }
    const idx = tryIndex(p);
    return idx && underPolyfills(p) ? browserMap(p, idx) : idx;
  }
  function tryIndex(p) { for (const e of [".js", ".json", ".cjs"]) if (isFile(join(p, "index" + e))) return join(p, "index" + e); return null; }
  function resolve(request, basedir, parent) {
    if (request.startsWith("file:")) request = decodeURIComponent(new URL(request).pathname);
    if (request.startsWith("/") || request.startsWith("./") || request.startsWith("../") || request === "." || request === "..") {
      const p = request.startsWith("/") ? normalize(request) : join(basedir, request);
      let r = tryFile(p) || (isDir(p) ? tryDir(p) : null);
      if (r && underPolyfills(r)) { const pd = packageDirOf(r); if (pd) r = browserMap(pd, r); }
      if (r) return r;
      throw notFound(request, parent);
    }
    if (request.startsWith("#")) {
      let d = basedir;
      for (;;) {
        const pkg = readPkg(d);
        if (pkg && pkg.imports) { const t = resolveExports(d, pkg.imports, request); if (t && isFile(t)) return t; if (t) { const bare = resolve(t.slice(d.length + 1), d, parent); return bare; } }
        if (pkg || d === "/") break; d = dirname(d);
      }
      throw notFound(request, parent);
    }
    if (underPolyfills(basedir)) {
      const pd = packageDirOf(join(basedir, "x.js")); const pkg = pd && readPkg(pd);
      if (pkg && pkg.browser && typeof pkg.browser === "object" && request in pkg.browser) {
        const to = pkg.browser[request];
        if (to === false) return join(polyfills, "../empty.js");
        if (typeof to === "string") return to.startsWith(".") ? resolve(to, pd, parent) : resolve(to, basedir, parent);
      }
    }
    const parts = request.split("/");
    const name = request.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const subpath = "." + request.slice(name.length);
    for (const nm of Module._nodeModulePaths(basedir)) {
      const pkgDir = join(nm, name);
      if (!isDir(pkgDir)) continue;
      const pkg = readPkg(pkgDir);
      if (pkg && pkg.exports !== undefined) {
        const t = resolveExports(pkgDir, pkg.exports, subpath);
        if (t) { const f = tryFile(t); if (f) return f; }
      }
      const p = join(pkgDir, subpath);
      const r = subpath === "." ? tryDir(pkgDir) : tryFile(p) || (isDir(p) ? tryDir(p) : null);
      if (r) return r;
    }
    throw notFound(request, parent);
  }

  // An ES module with no imports of its own (emnapi's bundles, say) loads natively, so it needs no compiler.
  // Cached per file, so stateful modules load once.
  const nativeModules = new Map();
  const selfContained = (src) => !/^[ \t]*(import[ \t]*[\w{*"']|export[ \t]*(\*|\{[^}]*\})[ \t]*from\b)/m.test(src);
  async function dynamicImport(spec, fromFile) {
    if (isBuiltin(spec)) { const ex = loadBuiltin(spec); return { ...ex, default: ex }; }
    const filename = resolve(spec, dirname(fromFile), null);
    if (isEsmFile(filename) && !Module._cache[filename]) {
      if (!nativeModules.has(filename)) {
        const src = readText(filename);
        nativeModules.set(filename, selfContained(src) ? import(URL.createObjectURL(new Blob([src], { type: "text/javascript" }))) : null);
      }
      const native = nativeModules.get(filename);
      if (native) return native;
    }
    const ex = Module._load(filename, null);
    await Module._cache[filename]?.evaluated;
    return ex && ex.__esModule ? { ...ex, default: ex.default ?? ex } : { ...(typeof ex === "object" ? ex : {}), default: ex };
  }
  function isEsmPackage(f) { let d = dirname(f); for (;;) { const pkg = readPkg(d); if (pkg) return pkg.type === "module"; if (d === "/") return false; d = dirname(d); } }

  const isEsmFile = (f) => f.endsWith(".mjs") || (f.endsWith(".js") && isEsmPackage(f));
  function compileModule(m, content, filename) {
    if (content.startsWith("#!")) content = "//" + content.slice(2);
    // SWC's CommonJS transform also rewrites import.meta (dirname, filename, resolve). Its import.meta.url reads
    // __filename, which an ES module may declare itself, so that one reads __vv_url instead.
    const esm = Boolean(transformEsm && isEsmFile(filename));
    // Bun's import.meta.require has no CommonJS form in SWC; packages only reach it under Bun, so it maps to require.
    if (esm) content = transformEsm(content, filename).replaceAll('require("url").pathToFileURL(__filename).toString()', "__vv_url").replaceAll("import.meta.require(", "require(");
    const src = content.replace(/(^|[^.\w$])import\(/g, "$1__vv_import(");
    // An ES module with top-level await runs in an async wrapper; import() waits for it (m.evaluated). Node refuses
    // require() of such modules, so nothing synchronous depends on them finishing.
    // An ES module runs one scope deeper, so its own __dirname or __filename shadows the wrapper's instead of
    // colliding with it.
    const compile = (prefix) => (0, eval)(esm
      ? `(function (exports, require, module, __filename, __dirname, __vv_import, __vv_url) { return (${prefix}function () {${src}\n})(); })\n//# sourceURL=file://${filename}`
      : `(${prefix}function (exports, require, module, __filename, __dirname, __vv_import) {${src}\n})\n//# sourceURL=file://${filename}`);
    let wrapper, isAsync = false;
    try {
      try { wrapper = compile(""); }
      catch (e) {
        if (!(e instanceof SyntaxError && /await is only valid/.test(e.message))) throw e;
        wrapper = compile("async ");
        isAsync = true;
      }
    } catch (e) { throw e instanceof SyntaxError ? new SyntaxError(`${e.message} (in ${filename})`) : e; }
    const req = makeRequire(m);
    m.require = (id) => Module._load(id, m, false);
    const result = wrapper.call(m.exports, m.exports, req, m, filename, dirname(filename), (s) => dynamicImport(String(s), filename), "file://" + encodeURI(filename));
    if (isAsync) m.evaluated = result;
    return result;
  }

  // ---------- built-ins ----------
  const poly = (pkg) => Module._load(join(polyfills, pkg), null);
  function loadBuiltin(id) {
    const name = id.startsWith("node:") ? id.slice(5) : id;
    if (builtins.has(name)) return builtins.get(name);
    const make = factories[name];
    if (!make) throw Object.assign(new Error(`No such built-in module: ${name}`), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
    const placeholder = {}; builtins.set(name, placeholder);
    const ex = make();
    builtins.set(name, ex);
    return ex;
  }
  const stubClass = (label) => class { constructor() { throw new Error(`${label} is not available in the browser build host`); } };

  Object.assign(factories, {
    events: () => { const ev = poly("events"); EventEmitter = ev; ev.EventEmitter = ev; ev.setMaxListeners = ev.setMaxListeners || (() => {}); ev.getEventListeners = (e, n) => e.listeners(n); return ev; },
    buffer: () => {
      const b = poly("buffer"); b.constants = { MAX_LENGTH: b.kMaxLength, MAX_STRING_LENGTH: 2 ** 29 }; b.isUtf8 = () => true;
      // The polyfill predates Node's base64url encoding; it is base64 with -_ and no padding.
      const B = b.Buffer, from = B.from, toString = B.prototype.toString, isEncoding = B.isEncoding;
      B.from = function (value, enc, ...rest) {
        if (typeof value === "string" && String(enc).toLowerCase() === "base64url") return from.call(this, value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
        return from.call(this, value, enc, ...rest);
      };
      B.prototype.toString = function (enc, ...rest) {
        if (String(enc).toLowerCase() === "base64url") return toString.call(this, "base64", ...rest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        return toString.call(this, enc, ...rest);
      };
      B.isEncoding = (enc) => String(enc).toLowerCase() === "base64url" || isEncoding(enc);
      return b;
    },
    util: () => {
      const u = poly("util");
      u.types = Object.assign({}, u.types || {}, { isPromise: (v) => v instanceof Promise, isRegExp: (v) => v instanceof RegExp, isDate: (v) => v instanceof Date, isNativeError: (v) => v instanceof Error, isAnyArrayBuffer: (v) => v instanceof ArrayBuffer || v instanceof SharedArrayBuffer, isUint8Array: (v) => v instanceof Uint8Array, isProxy: () => false, isAsyncFunction: (f) => f && f.constructor && f.constructor.name === "AsyncFunction", isGeneratorFunction: (f) => f && f.constructor && /GeneratorFunction/.test(f.constructor.name) });
      u.TextEncoder = TextEncoder; u.TextDecoder = TextDecoder;
      u.stripVTControlCharacters = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
      u.styleText = (_f, s) => s; u.parseArgs = undefined; u.getSystemErrorName = (c) => String(c); u.isDeepStrictEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      // Like Node, an Error inspects as its stack, followed by its cause and an AggregateError's errors.
      const inspect = u.inspect || ((v) => String(v));
      const inspectError = (e, depth = 0) => {
        const pad = "  ".repeat(depth);
        let out = String(e.stack || e).split("\n").map((l) => pad + l).join("\n");
        if (e instanceof AggregateError) for (const inner of e.errors || []) out += `\n${pad}  [errors]: ` + (inner instanceof Error ? inspectError(inner, depth + 2).trimStart() : String(inner));
        if (e.cause !== undefined) out += `\n${pad}  [cause]: ` + (e.cause instanceof Error ? inspectError(e.cause, depth + 1).trimStart() : String(e.cause));
        return out;
      };
      u.inspect = Object.assign((v, ...rest) => (v instanceof Error ? inspectError(v) : inspect(v, ...rest)), inspect);
      if (!u.inspect.custom) u.inspect.custom = Symbol.for("nodejs.util.inspect.custom");
      u.debuglog = () => Object.assign(() => {}, { enabled: false });
      return u;
    },
    "util/types": () => loadBuiltin("util").types,
    path: () => { const p = poly("path-browserify"); p.posix = p; p.win32 = p; p.toNamespacedPath = (x) => x; return p; },
    "path/posix": () => loadBuiltin("path"), "path/win32": () => loadBuiltin("path"),
    stream: () => { const s = poly("stream-browserify"); const rs = poly("readable-stream"); s.promises = { pipeline: (...a) => new Promise((res, rej) => rs.pipeline(...a, (e) => (e ? rej(e) : res()))), finished: (st) => new Promise((res, rej) => rs.finished(st, (e) => (e ? rej(e) : res()))) }; s.finished = rs.finished; s.pipeline = rs.pipeline; s.addAbortSignal = (_s, st) => st; s.Readable.fromWeb = s.Readable.fromWeb || (() => { throw new Error("Readable.fromWeb unsupported"); }); return s; },
    "stream/promises": () => loadBuiltin("stream").promises,
    "stream/web": () => ({ ReadableStream, WritableStream, TransformStream, TextEncoderStream, TextDecoderStream, CompressionStream, DecompressionStream, ByteLengthQueuingStrategy, CountQueuingStrategy }),
    string_decoder: () => poly("string_decoder"),
    querystring: () => poly("querystring-es3"),
    punycode: () => poly("punycode"),
    assert: () => { const a = poly("assert"); a.strict = a; return a; },
    zlib: () => { const z = poly("browserify-zlib"); z.constants = z.constants || {}; z.brotliCompressSync = (b) => b; z.brotliDecompressSync = (b) => b; z.createBrotliCompress = () => { throw new Error("brotli unsupported"); }; return z; },
    url: () => {
      const u = poly("url");
      u.URL = URL; u.URLSearchParams = URLSearchParams;
      u.pathToFileURL = (p) => new URL("file://" + encodeURI(p.startsWith("/") ? p : join(cwd, p)).replace(/\?/g, "%3F").replace(/#/g, "%23"));
      u.fileURLToPath = (x) => decodeURIComponent(new URL(String(x)).pathname);
      u.domainToASCII = (d) => d; u.urlToHttpOptions = (x) => x;
      return u;
    },
    os: () => {
      const o = poly("os-browserify");
      return Object.assign({}, o, { platform: () => "linux", type: () => "Linux", arch: () => "x64", release: () => "6.0.0", tmpdir: () => "/tmp", homedir: () => env.HOME || "/home/user", hostname: () => "browser", EOL: "\n", cpus: () => Array.from({ length: 2 }, () => ({ model: "browser", speed: 0, times: {} })), availableParallelism: () => 2, totalmem: () => 4 << 30, freemem: () => 2 << 30, endianness: () => "LE", userInfo: () => ({ username: "user", uid: 0, gid: 0, shell: "/bin/sh", homedir: env.HOME || "/home/user" }), networkInterfaces: () => ({}), loadavg: () => [0, 0, 0], uptime: () => 0, constants: { signals: {}, errno: {} }, devNull: "/dev/null", machine: () => "x86_64", version: () => "browser" });
    },
    crypto: () => {
      const createHash = poly("create-hash"), createHmac = poly("create-hmac"), randomBytes = poly("randombytes");
      const Buffer = loadBuiltin("buffer").Buffer;
      return {
        createHash, createHmac, randomBytes, webcrypto: crypto, subtle: crypto.subtle,
        randomUUID: () => crypto.randomUUID(), getRandomValues: (a) => crypto.getRandomValues(a),
        randomFillSync: (a) => { crypto.getRandomValues(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); return a; },
        randomInt: (a, b) => { if (b === undefined) { b = a; a = 0; } return a + Math.floor(Math.random() * (b - a)); },
        timingSafeEqual: (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0,
        getHashes: () => ["md5", "sha1", "sha256", "sha512"], constants: {},
        hash: (alg, data, enc = "hex") => createHash(alg).update(data).digest(enc),
      };
    },
    fs: () => makeFs(), "fs/promises": () => loadBuiltin("fs").promises,
    constants: () => ({ O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 }),
    module: () => Module,
    // Worker runtimes share the main runtime's process, as in-realm threads share globals.
    process: () => processObj || (processObj = worker && globalThis.process ? globalThis.process : makeProcess()),
    console: () => Object.assign(Object.create(console), { Console: class { constructor() { return console; } } }),
    timers: () => ({ setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setImmediate: globalThis.setImmediate, clearImmediate: globalThis.clearImmediate }),
    "timers/promises": () => ({ setTimeout: (ms, v) => new Promise((r) => setTimeout(() => r(v), ms)), setImmediate: (v) => new Promise((r) => globalThis.setImmediate(() => r(v))), scheduler: { wait: (ms) => new Promise((r) => setTimeout(r, ms)), yield: () => new Promise((r) => setTimeout(r, 0)) } }),
    perf_hooks: () => ({ performance, PerformanceObserver: class { observe() {} disconnect() {} }, monitorEventLoopDelay: () => ({ enable() {}, disable() {}, percentile: () => 0 }), constants: {} }),
    async_hooks: () => makeAsyncHooks(),
    diagnostics_channel: () => { const ch = () => ({ hasSubscribers: false, publish() {}, subscribe() {}, unsubscribe() {}, bindStore() {}, runStores: (_d, fn, t, ...a) => fn.apply(t, a) }); return { channel: ch, hasSubscribers: () => false, subscribe() {}, unsubscribe() {}, tracingChannel: () => ({ start: ch(), end: ch(), asyncStart: ch(), asyncEnd: ch(), error: ch(), hasSubscribers: false, traceSync: (fn, _c, t, ...a) => fn.apply(t, a), tracePromise: (fn, _c, t, ...a) => fn.apply(t, a), traceCallback: (fn, _p, _c, t, ...a) => fn.apply(t, a) }) }; },
    vm: () => {
      const runInContext = (code, ctx) => { const keys = Object.keys(ctx || {}); return Function(...keys, `return eval(${JSON.stringify(String(code))})`)(...keys.map((k) => ctx[k])); };
      class Script { constructor(code) { this.code = code; } runInThisContext() { return (0, eval)(this.code); } runInNewContext(ctx) { return runInContext(this.code, ctx); } runInContext(ctx) { return runInContext(this.code, ctx); } createCachedData() { return new Uint8Array(0); } }
      return { Script, runInThisContext: (c) => (0, eval)(c), runInNewContext: runInContext, runInContext, createContext: (c = {}) => c, isContext: () => true, compileFunction: (code, params = []) => Function(...params, code), constants: {} };
    },
    v8: () => ({ getHeapStatistics: () => ({ heap_size_limit: 4 << 30, total_heap_size: 0, used_heap_size: 0 }), getHeapSpaceStatistics: () => [], setFlagsFromString() {}, serialize: (v) => new TextEncoder().encode(JSON.stringify(v)), deserialize: (b) => JSON.parse(new TextDecoder().decode(b)), writeHeapSnapshot: () => "", startupSnapshot: { isBuildingSnapshot: () => false } }),
    tty: () => ({ isatty: () => false, WriteStream: stubClass("tty.WriteStream"), ReadStream: stubClass("tty.ReadStream") }),
    readline: () => ({ createInterface: () => ({ on() { return this; }, close() {}, question(_q, cb) { cb(""); } }), emitKeypressEvents() {}, clearLine() {}, cursorTo() {}, moveCursor() {} }),
    worker_threads: () => makeWorkerThreads(),
    child_process: () => makeChildProcess(),
    http: () => ({ STATUS_CODES: {}, METHODS: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], createServer: () => { throw new Error("http.createServer is not available in the browser build host"); }, Agent: class { constructor() {} }, globalAgent: {}, request: () => { throw new Error("http.request is not available"); }, get: () => { throw new Error("http.get is not available"); }, IncomingMessage: class {}, ServerResponse: class {}, Server: class {}, OutgoingMessage: class {}, validateHeaderName() {}, validateHeaderValue() {} }),
    https: () => loadBuiltin("http"), http2: () => ({ constants: {}, connect: () => { throw new Error("http2 is not available"); } }),
    net: () => ({ isIP: (s) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : s.includes(":") ? 6 : 0), isIPv4: (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s), isIPv6: (s) => s.includes(":"), Socket: class {}, createServer: () => { throw new Error("net.createServer is not available"); }, connect: () => { throw new Error("net.connect is not available"); } }),
    tls: () => ({ connect: () => { throw new Error("tls is not available"); } }),
    dns: () => ({ lookup: (_h, _o, cb) => (cb || _o)(new Error("dns unavailable")), promises: { lookup: async () => { throw new Error("dns unavailable"); } } }),
    "dns/promises": () => loadBuiltin("dns").promises,
    inspector: () => ({ url: () => undefined, open() {}, close() {}, Session: class { connect() {} post() {} disconnect() {} } }),
    // Node's WASI class on @tybys/wasm-util, over this runtime's file system.
    wasi: () => ({
      WASI: class WASI {
        constructor(o = {}) {
          this._wasi = new WasmUtilWASI({ version: o.version || "preview1", args: o.args, env: o.env, preopens: o.preopens, fs: fsc, returnOnExit: o.returnOnExit ?? true });
          this.wasiImport = this._wasi.wasiImport;
        }
        getImportObject() { return this._wasi.getImportObject(); }
        start(instance) { return this._wasi.start(instance); }
        initialize(instance) { return this._wasi.initialize(instance); }
      },
    }),
  });

  // A real thread has no compiler, so this thread compiles every ES module the thread will load, found by following
  // string-literal require() calls from its entry (after compilation, imports are require() calls too). Cached per
  // entry: each wasm thread of a binding starts from the same entry.
  const threadGraphs = new Map();
  function compileThreadGraph(entry) {
    if (!transformEsm) return {};
    if (threadGraphs.has(entry)) return threadGraphs.get(entry);
    const transformed = {}, seen = new Set(), todo = [entry];
    while (todo.length) {
      const file = todo.pop();
      if (seen.has(file) || !/\.[cm]?js$/.test(file)) continue;
      seen.add(file);
      let code = readText(file);
      if (isEsmFile(file)) transformed[file] = code = transformEsm(code, file);
      // Also renamed requires: SWC turns a module's own `const require = createRequire(...)` into require1.
      for (const [, , spec] of code.matchAll(/require\w*\(\s*(["'])([^"'\n]+)\1\s*\)/g)) {
        let request = spec;
        for (const [from, to] of Object.entries(redirects)) if (request === from || request.startsWith(from + "/")) { request = to + request.slice(from.length); break; }
        if (isBuiltin(request)) continue;
        try { const target = resolve(request, dirname(file), null); if (!isBuiltin(target)) todo.push(target); } catch {}
      }
    }
    threadGraphs.set(entry, transformed);
    return transformed;
  }

  // A Worker is a real thread (spawnWorker) with its own runtime. This thread compiles the ES modules it will load
  // (compileThreadGraph), since the compiler lives here.
  function makeWorkerThreads() {
    const EE = loadBuiltin("events");
    const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");
    class Worker extends EE {
      constructor(file, opts = {}) {
        super();
        if (!spawnWorker) throw new Error("worker_threads.Worker is not available here");
        this.threadId = ++nextThreadId;
        const filename = String(file).startsWith("file:") ? decodeURIComponent(new URL(String(file)).pathname) : String(file);
        const thread = spawnWorker({
          filename, transformed: compileThreadGraph(filename), threadId: this.threadId,
          env: opts.env && opts.env !== SHARE_ENV ? { ...opts.env } : { ...loadBuiltin("process").env },
          argv: [argv[0], filename, ...(opts.argv || []).map(String)],
          workerData: opts.workerData === undefined ? null : opts.workerData,
        }, opts.transferList || []);
        this._thread = thread;
        hold(this);
        thread.onmessage = (e) => {
          const d = e.data;
          if (d && d.__nodeError) { this.emit("error", Object.assign(new Error(d.__nodeError.message), d.__nodeError)); return; }
          if (d && d.__nodeExit !== undefined) { this._close(); return this.emit("exit", d.__nodeExit); }
          this.emit("message", d);
        };
        setTimeout(() => this.emit("online"), 0);
      }
      _close() { if (this._thread) { this._thread.close(); this._thread = null; } release(this); }
      postMessage(message, transfer) { if (this._thread) this._thread.postMessage(message, transfer); }
      ref() { if (this._thread) hold(this); return this; }
      unref() { release(this); return this; }
      terminate() {
        if (this._thread) this._thread.postMessage({ __nodeTerminate: true });
        this._close();
        setTimeout(() => this.emit("exit", 1), 0);
        return Promise.resolve(1);
      }
    }
    // parentPort is this thread's link to its parent. Like Node's, it holds incoming messages until the first
    // 'message' listener is attached (code often awaits setup before listening).
    const parentPort = !worker ? null : (() => {
      const port = Object.assign(new EE(), { postMessage: (m, t) => worker.port.postMessage(m, t), close() {}, start() {}, ref() {}, unref() {} });
      let started = false;
      port.on("newListener", (event) => {
        if (event !== "message" || started) return;
        started = true;
        worker.port.addEventListener("message", (e) => port.emit("message", e.data));
      });
      return port;
    })();
    return {
      isMainThread: !worker, parentPort, workerData: worker ? worker.workerData : null, threadId: worker ? worker.threadId : 0,
      resourceLimits: {}, Worker, MessageChannel, MessagePort, BroadcastChannel, SHARE_ENV,
      markAsUntransferable() {}, receiveMessageOnPort: () => undefined, getEnvironmentData() {}, setEnvironmentData() {},
    };
  }

  function makeAsyncHooks() {
    // One render at a time: the store set by run() stays current for the async work it starts until run() is
    // entered again. Enough for the compile path, which does not prerender.
    class AsyncLocalStorage {
      constructor() { this._store = undefined; }
      static bind(fn) { return fn; }
      static snapshot() { return (fn, ...a) => fn(...a); }
      getStore() { return this._store; }
      run(store, fn, ...args) { const prev = this._store; this._store = store; try { const r = fn(...args); if (r && typeof r.then === "function") return r.finally(() => { if (this._store === store) this._store = prev; }); this._store = prev; return r; } catch (e) { this._store = prev; throw e; } }
      exit(fn, ...args) { const prev = this._store; this._store = undefined; try { return fn(...args); } finally { this._store = prev; } }
      enterWith(store) { this._store = store; }
      disable() { this._store = undefined; }
    }
    class AsyncResource { constructor(type) { this.type = type; } runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); } emitDestroy() { return this; } bind(fn) { return fn.bind(this); } static bind(fn) { return fn; } asyncId() { return 1; } triggerAsyncId() { return 0; } }
    return { AsyncLocalStorage, AsyncResource, createHook: () => ({ enable() { return this; }, disable() { return this; } }), executionAsyncId: () => 1, triggerAsyncId: () => 0, executionAsyncResource: () => ({}) };
  }

  function makeChildProcess() {
    // Next's compile mode creates a static-check worker it never calls; a child that stays silent is enough.
    const { EventEmitter: EE } = loadBuiltin("events");
    const fakeChild = () => { const c = new EE(); c.pid = 0; c.connected = true; c.killed = false; c.stdout = new EE(); c.stderr = new EE(); c.stdin = Object.assign(new EE(), { write() { return true; }, end() {} }); c.send = () => true; c.kill = () => { c.killed = true; c.connected = false; setTimeout(() => c.emit("exit", 0, null), 0); return true; }; c.disconnect = () => { c.connected = false; }; c.ref = c.unref = () => {}; return c; };
    const nope = (name) => () => { throw Object.assign(new Error(`child_process.${name} is not available in the browser build host`), { code: "ENOSYS" }); };
    return { fork: () => fakeChild(), spawn: () => fakeChild(), exec: (_c, _o, cb) => { (cb || _o)?.(new Error("exec unavailable"), "", ""); return fakeChild(); }, execFile: (_f, _a, _o, cb) => { (cb || _o || _a)?.(new Error("execFile unavailable"), "", ""); return fakeChild(); }, execSync: nope("execSync"), execFileSync: nope("execFileSync"), spawnSync: () => ({ status: 1, error: new Error("spawnSync unavailable"), stdout: "", stderr: "" }), ChildProcess: class {} };
  }

  function makeFs() {
    const Buffer = loadBuiltin("buffer").Buffer;
    const MESSAGES = { ENOENT: "no such file or directory", EEXIST: "file already exists", ENOTDIR: "not a directory", EISDIR: "illegal operation on a directory", ENOTEMPTY: "directory not empty", EBADF: "bad file descriptor", EPERM: "operation not permitted", EINVAL: "invalid argument" };
    const ERRNO = { ENOENT: -2, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, ENOTEMPTY: -39, EBADF: -9, EPERM: -1, EINVAL: -22 };
    const wrap = (syscall, fn) => (...args) => {
      try { return fn(...args); } catch (e) {
        if (!e.code || e.syscall) throw e;
        const path = typeof args[0] === "string" ? args[0] : undefined;
        const err = new Error(`${e.code}: ${MESSAGES[e.code] || e.message}, ${syscall}${path ? ` '${path}'` : ""}`);
        Object.assign(err, { code: e.code, errno: ERRNO[e.code], syscall, path });
        throw err;
      }
    };
    const abs = (p) => { p = p instanceof URL ? decodeURIComponent(p.pathname) : String(p); if (p.startsWith("file:")) p = decodeURIComponent(new URL(p).pathname); return p.startsWith("/") ? normalize(p) : join(cwd, p); };
    const enc = (o) => (typeof o === "string" ? o : o && o.encoding);
    const toBytes = (d, e) => (typeof d === "string" ? Buffer.from(d, e || "utf8") : d instanceof Uint8Array ? d : Buffer.from(d.buffer ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : d));
    const statOrUndef = (fn, p, o) => { try { return fn(abs(p), o); } catch (e) { if (o && o.throwIfNoEntry === false && e.code === "ENOENT") return undefined; throw e; } };
    const mkdirp = (p) => { const parts = p.split("/").filter(Boolean); let cur = ""; for (const part of parts) { cur += "/" + part; try { fsc.mkdirSync(cur); } catch (e) { if (e.code !== "EEXIST") throw e; } } };
    const rmrf = (p) => { let st; try { st = fsc.lstatSync(p); } catch (e) { if (e.code === "ENOENT") return; throw e; } if (st.isDirectory()) { for (const n of fsc.readdirSync(p)) rmrf(join(p, n)); fsc.rmdirSync(p); } else fsc.unlinkSync(p); };
    const s = {
      existsSync: (p) => { try { fsc.statSync(abs(p)); return true; } catch { return false; } },
      readFileSync: wrap("open", (p, o) => { const b = Buffer.from(readBytes(typeof p === "number" ? (() => { throw Object.assign(new Error("fd read"), { code: "EBADF" }); })() : abs(p))); const e = enc(o); return e ? b.toString(e) : b; }),
      writeFileSync: wrap("open", (p, d, o) => fsc.writeFileBytes(abs(p), toBytes(d, enc(o)))),
      appendFileSync: wrap("open", (p, d, o) => { let prev = new Uint8Array(0); try { prev = readBytes(abs(p)); } catch {} fsc.writeFileBytes(abs(p), Buffer.concat([Buffer.from(prev), Buffer.from(toBytes(d, enc(o)))])); }),
      statSync: wrap("stat", (p, o) => statOrUndef(fsc.statSync, p, o)),
      lstatSync: wrap("lstat", (p, o) => statOrUndef(fsc.lstatSync, p, o)),
      fstatSync: wrap("fstat", (fd, o) => fsc.fstatSync(fd, o)),
      readdirSync: wrap("scandir", (p, o) => {
        const dir = abs(p), types = !!(o && o.withFileTypes), recursive = !!(o && o.recursive);
        const list = [];
        const visit = (d, prefix) => {
          for (const e of fsc.readdirSync(d, { withFileTypes: true })) {
            const rel = prefix ? prefix + "/" + e.name : e.name;
            if (types) { e.parentPath = e.path = d; list.push(e); } else list.push(rel);
            if (recursive && e.isDirectory()) visit(join(d, e.name), rel);
          }
        };
        visit(dir, "");
        return list;
      }),
      opendirSync: wrap("opendir", (p) => {
        const entries = s.readdirSync(p, { withFileTypes: true }); let i = 0;
        const next = () => (i < entries.length ? entries[i++] : null);
        return { path: abs(p), readSync: next, read: async () => next(), closeSync() {}, close: async () => {}, async *[Symbol.asyncIterator]() { let e; while ((e = next())) yield e; }, *[Symbol.iterator]() { let e; while ((e = next())) yield e; } };
      }),
      mkdirSync: wrap("mkdir", (p, o) => { p = abs(p); if (o && (o.recursive || o === true)) { const existed = s.existsSync(p); mkdirp(p); return existed ? undefined : p; } fsc.mkdirSync(p); }),
      rmSync: wrap("rm", (p, o) => { p = abs(p); if (!s.existsSync(p)) { if (o && o.force) return; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } if (o && o.recursive) rmrf(p); else fsc.unlinkSync(p); }),
      rmdirSync: wrap("rmdir", (p, o) => (o && o.recursive ? rmrf(abs(p)) : fsc.rmdirSync(abs(p)))),
      unlinkSync: wrap("unlink", (p) => fsc.unlinkSync(abs(p))),
      renameSync: wrap("rename", (a, b) => fsc.renameSync(abs(a), abs(b))),
      copyFileSync: wrap("copyfile", (a, b) => fsc.writeFileBytes(abs(b), readBytes(abs(a)))),
      cpSync: wrap("cp", (a, b, o) => { const copy = (x, y) => { const st = fsc.statSync(x); if (st.isDirectory()) { mkdirp(y); for (const n of fsc.readdirSync(x)) copy(join(x, n), join(y, n)); } else fsc.writeFileBytes(y, readBytes(x)); }; copy(abs(a), abs(b)); }),
      realpathSync: Object.assign(wrap("realpath", (p) => fsc.realpathSync(abs(p))), { native: wrap("realpath", (p) => fsc.realpathSync(abs(p))) }),
      readlinkSync: wrap("readlink", (p) => fsc.readlinkSync(abs(p))),
      accessSync: wrap("access", (p) => { fsc.statSync(abs(p)); }),
      openSync: wrap("open", (p, f = "r") => fsc.openSync(abs(p), f)),
      closeSync: (fd) => fsc.closeSync(fd),
      readSync: (fd, b, off, len, pos) => (typeof off === "object" && off ? fsc.readSync(fd, b, off.offset || 0, off.length ?? b.length, off.position ?? null) : fsc.readSync(fd, b, off, len, pos)),
      writeSync: (fd, d, off, len, pos) => { if (typeof d === "string") { const b = Buffer.from(d); return fsc.writeSync(fd, b, 0, b.length, typeof off === "number" ? off : null); } return fsc.writeSync(fd, d, off ?? 0, len ?? d.length - (off ?? 0), pos ?? null); },
      ftruncateSync: (fd, l) => fsc.ftruncateSync(fd, l), fsyncSync() {}, fdatasyncSync() {},
      utimesSync: (p, a, m) => fsc.utimesSync(abs(p), +a / 1000 || 0, +m / 1000 || 0),
      symlinkSync: wrap("symlink", (t, p) => fsc.symlinkSync(t, abs(p))),
      chmodSync() {}, chownSync() {}, lchownSync() {},
      mkdtempSync: (prefix) => { const p = abs(prefix + Math.random().toString(36).slice(2, 8)); mkdirp(p); return p; },
      watch: () => ({ close() {}, on() { return this; } }), watchFile() {}, unwatchFile() {},
      constants: loadBuiltin("constants"),
    };
    s.createWriteStream = (p, o) => {
      const { Writable } = loadBuiltin("stream");
      const file = abs(p); const flags = (o && o.flags) || "w";
      const fd = fsc.openSync(file, flags === "a" ? "a" : "w");
      const w = new Writable({ write(chunk, e, cb) { try { fsc.writeSync(fd, toBytes(chunk, e), 0, chunk.length, null); cb(); } catch (err) { cb(err); } }, final(cb) { fsc.closeSync(fd); cb(); } });
      w.path = file; w.bytesWritten = 0; w.close = (cb) => w.end(cb);
      return w;
    };
    s.createReadStream = (p, o) => { const { Readable } = loadBuiltin("stream"); const data = s.readFileSync(p); const r = new Readable({ read() { this.push(data); this.push(null); } }); r.path = abs(p); if (o && o.encoding) r.setEncoding(o.encoding); return r; };
    const promisifyAll = (names) => Object.fromEntries(names.map((n) => [n, (...a) => new Promise((res, rej) => { try { res(s[n + "Sync"](...a)); } catch (e) { rej(e); } })]));
    const asyncNames = ["opendir", "readFile", "writeFile", "appendFile", "stat", "lstat", "readdir", "mkdir", "rm", "rmdir", "unlink", "rename", "copyFile", "cp", "realpath", "readlink", "access", "utimes", "symlink", "chmod", "mkdtemp"];
    s.promises = promisifyAll(asyncNames);
    s.promises.open = async (p, f) => { const fd = s.openSync(p, f); return { fd, close: async () => s.closeSync(fd), read: async (b, off, len, pos) => ({ bytesRead: s.readSync(fd, b, off, len, pos), buffer: b }), write: async (d) => ({ bytesWritten: s.writeSync(fd, d) }), stat: async () => s.fstatSync(fd), readFile: async (o) => s.readFileSync(p, o), writeFile: async (d) => s.writeFileSync(p, d) }; };
    s.promises.constants = s.constants;
    for (const n of asyncNames) s[n] = (...a) => { const cb = typeof a[a.length - 1] === "function" ? a.pop() : null; let r, err = null; try { r = s[n + "Sync"](...a); } catch (e) { err = e; } if (cb) queueMicrotask(() => (n === "exists" ? cb(!err) : cb(err, r))); };
    s.exists = (p, cb) => queueMicrotask(() => cb(s.existsSync(p)));
    s.close = (fd, cb) => { fsc.closeSync(fd); cb && queueMicrotask(() => cb(null)); };
    s.fstat = (fd, o, cb) => { cb = typeof o === "function" ? o : cb; let r, err = null; try { r = s.fstatSync(fd); } catch (e) { err = e; } queueMicrotask(() => cb(err, r)); };
    s.open = (p, f, m, cb) => { cb = [f, m, cb].find((x) => typeof x === "function"); let r, err = null; try { r = s.openSync(p, typeof f === "string" ? f : "r"); } catch (e) { err = e; } queueMicrotask(() => cb(err, r)); };
    s.Stats = class {}; s.Dirent = class {};
    return s;
  }

  // ---------- globals for loaded code ----------
  const installGlobals = () => {
    const { Buffer } = loadBuiltin("buffer");
    globalThis.Buffer = Buffer; globalThis.process = loadBuiltin("process"); globalThis.global = globalThis;
    // Node's TextDecoder accepts views over SharedArrayBuffer (N-API buffers point into shared wasm memory);
    // browsers throw, so copy those first.
    if (!globalThis.__vvTextDecoder) {
      globalThis.__vvTextDecoder = true;
      const decode = TextDecoder.prototype.decode;
      TextDecoder.prototype.decode = function (input, options) {
        if (input && typeof SharedArrayBuffer !== "undefined" && input.buffer instanceof SharedArrayBuffer) input = new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
        return decode.call(this, input, options);
      };
    }
    // In Node, console writes to stdout/stderr; in a worker it only reaches DevTools.
    if (!globalThis.__vvConsole) {
      globalThis.__vvConsole = true;
      const { format } = loadBuiltin("util");
      const toOut = (fd) => (...args) => write(fd, format(...args) + "\n");
      Object.assign(console, { log: toOut(1), info: toOut(1), debug: toOut(1), warn: toOut(2), error: toOut(2), trace: toOut(2) });
    }
    // Node timers return Timeout objects (ref/unref/refresh); browsers return numbers. Referenced timers, immediates
    // and MessagePorts hold the event loop open (see `loop`).
    if (!globalThis.__vvNodeTimers) {
      globalThis.__vvNodeTimers = true;
      const [st, ct, si, ci] = [setTimeout, clearTimeout, setInterval, clearInterval].map((f) => f.bind(globalThis));
      loop.setTimeout = st;
      const byId = new Map();
      class Timeout {
        constructor(make, fn, ms, args) {
          this._make = make; this._ms = ms; this._args = args; this._ref = true; this._repeat = make === si;
          this._fn = this._repeat ? fn : (...a) => { this._stop(); fn(...a); };
          this._start();
        }
        _start() { this._id = this._make(this._fn, this._ms, ...this._args); byId.set(this._id, this); this._active = true; if (this._ref) hold(this); }
        _stop() { byId.delete(this._id); this._active = false; release(this); }
        ref() { this._ref = true; if (this._active) hold(this); return this; }
        unref() { this._ref = false; release(this); return this; }
        hasRef() { return this._ref; }
        refresh() { ct(this._id); byId.delete(this._id); this._start(); return this; }
        close() { ct(this._id); this._stop(); return this; } [Symbol.toPrimitive]() { return this._id; }
      }
      const clear = (h) => { const t = h && typeof h === "object" ? h : byId.get(h); if (t instanceof Timeout) t.close(); else if (h != null) ct(h); };
      globalThis.setTimeout = (fn, ms, ...args) => new Timeout(st, fn, ms, args);
      globalThis.setInterval = (fn, ms, ...args) => new Timeout(si, fn, ms, args);
      globalThis.clearTimeout = clear;
      globalThis.clearInterval = clear;
    }
    if (!globalThis.setImmediate) {
      const ch = new MessageChannel(), q = new Map(); let id = 0;
      ch.port1.onmessage = (e) => { const t = q.get(e.data); if (t) { q.delete(e.data); release(t.handle); t.fn(...t.args); } };
      globalThis.setImmediate = (fn, ...args) => {
        const i = ++id, handle = { _id: i, ref() { return this; }, unref() { release(this); return this; }, hasRef: () => true };
        q.set(i, { fn, args, handle }); hold(handle); ch.port2.postMessage(i); return handle;
      };
      globalThis.clearImmediate = (h) => { if (h && q.delete(h._id)) release(h); };
    }
    // Node's MessagePort is also an EventEmitter-style object: on('message', value => ...), plus ref()/unref()
    // (emnapi refs one while native async work is pending).
    if (typeof MessagePort !== "undefined" && !("ref" in MessagePort.prototype)) {
      const proto = MessagePort.prototype, wrapped = new WeakMap();
      proto.ref = function () { hold(this); return this; };
      proto.unref = function () { release(this); return this; };
      proto.on = proto.addListener = function (type, fn) {
        const listener = type === "message" ? (e) => fn(e.data) : fn;
        wrapped.set(fn, listener);
        this.addEventListener(type, listener);
        if (type === "message") this.start();
        return this;
      };
      proto.once = function (type, fn) { const once = (v) => { this.off(type, once); fn(v); }; return this.on(type, once); };
      proto.off = proto.removeListener = function (type, fn) { this.removeEventListener(type, wrapped.get(fn) || fn); return this; };
    }
  };

  return {
    Module, require: (id, from = join(cwd, "noop.js")) => Module._load(id, new Module(from)), get process() { return loadBuiltin("process"); }, ProcessExit,
    runMain(file) {
      installGlobals();
      const filename = resolve(file, cwd, null);
      mainModule = new Module(filename); mainModule.id = ".";
      Module._cache[filename] = mainModule;
      mainModule.load(filename);
      return mainModule;
    },
    installGlobals,
    // Resolves with the exit code once nothing holds the event loop open, after emitting 'beforeExit' (which may
    // schedule more work), the way a Node process ends without process.exit().
    whenIdle() {
      return new Promise((resolve) => {
        let scheduled = false;
        const check = () => {
          if (scheduled) return;
          scheduled = true;
          loop.setTimeout(() => {
            scheduled = false;
            if (loop.refs.size) return;
            const p = loadBuiltin("process");
            p.emit("beforeExit", p.exitCode ?? 0);
            loop.setTimeout(() => { if (loop.refs.size) return; loop.listeners.delete(check); resolve(p.exitCode ?? 0); }, 0);
          }, 0);
        };
        loop.listeners.add(check);
        check();
      });
    },
  };
}
