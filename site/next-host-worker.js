// Runs the real `next build --wasi --experimental-build-mode compile` in this worker: Next's own JS on the small
// runtime in node/runtime.js, Turbopack + SWC from the wasm binding instantiated here.
import { createFsClient } from "./fs-client.js";
import { createBinding } from "./binding.js";
import { createRuntime } from "./node/runtime.js";
import { getDefaultContext } from "/pkg/emnapi-runtime.mjs";

const t0 = performance.now();
const sec = () => ((performance.now() - t0) / 1000).toFixed(2) + "s";
const post = (type, text) => self.postMessage({ type, text });
const log = (...a) => post("log", `[host +${sec()}] ${a.join(" ")}`);

// "start" loads the wasm binding while the user picks an app; "run" starts next once the app is in the file system.
let started;
self.onmessage = async ({ data }) => {
  if (data.type === "start") {
    const fsClient = createFsClient(data.fsPort, data.regPort);
    const life = new Int32Array(new SharedArrayBuffer(32));
    started = createBinding({ fsClient, wasmUrl: data.wasmUrl, parallelism: data.parallelism, life }).then(({ exports, pool }) => {
      // Errors thrown in callbacks that wasm calls into would otherwise be swallowed by emnapi.
      const register = exports.registerWorkerScheduler;
      const loud = (name, fn) => (...a) => { try { return fn(...a); } catch (e) { console.error(`${name} failed:`, e && (e.stack || e)); throw e; } };
      if (register) exports.registerWorkerScheduler = (create, terminate) => register.call(exports, loud("loader worker create", create), loud("loader worker terminate", terminate));
      globalThis.__NEXT_WASI_NAPI_EXPORTS__ = exports;
      self.postMessage({ type: "binding-ready", target: exports.getTargetTriple(), threads: pool.workers.length });
      return { fsClient, pool, exports };
    }, (e) => { self.postMessage({ type: "done", ok: false, code: -1, error: String(e && (e.stack || e)) }); throw e; });
    return;
  }
  if (data.type !== "run") return;
  const { fsClient, pool, exports } = await started;

  let stdoutBuf = "";
  const write = (fd, s) => {
    stdoutBuf += s;
    let i;
    while ((i = stdoutBuf.indexOf("\n")) >= 0) { post("out", stdoutBuf.slice(0, i).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")); stdoutBuf = stdoutBuf.slice(i + 1); }
  };
  const rt = createRuntime({
    fs: fsClient, cwd: data.appDir, polyfills: data.polyfills, write,
    // Next hands loader workers the binding's package name as bindingPath; give them the instance already running.
    aliases: { "@next/swc-wasm-wasi": exports },
    // Native packages Tailwind needs: lightningcss has an official wasm build; oxide gets a JS scanner (see the file).
    redirects: { lightningcss: "lightningcss-wasm", "@tailwindcss/oxide": "/polyfills/node_modules/@vv/tailwind-oxide-js/index.js" },
    // require() of an ES module (Node 22+), compiled to CommonJS by the SWC already in the binding.
    transformEsm: (source, filename) => exports.transformSync(source, false, globalThis.Buffer.from(JSON.stringify({
      filename, isModule: true, sourceMaps: false,
      jsc: { parser: { syntax: "ecmascript", importAttributes: true }, target: "es2022" },
      module: { type: "commonjs", importInterop: "node" },
    }))).code,
    env: { HOME: "/home/user", PATH: "/usr/bin", NEXT_TELEMETRY_DISABLED: "1", TURBO_TASKS_AVAILABLE_PARALLELISM: String(data.parallelism), ...data.env },
    argv: ["/usr/bin/node", data.appDir + "/node_modules/next/dist/bin/next", ...data.args],
  });

  // emnapi captured Buffer when its context was created, before the runtime installed the polyfill; Turbopack's loader
  // workers exchange messages as Buffers.
  rt.installGlobals();
  getDefaultContext().features.Buffer = globalThis.Buffer;

  let finished = false;
  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    if (stdoutBuf) post("out", stdoutBuf);
    const outputs = [];
    // Symlinks stay symlinks: Turbopack links server externals as .next/node_modules/<pkg>-<hash> -> ../../node_modules/<pkg>,
    // and the package only resolves its own imports from the link target's real location.
    const walk = (d) => {
      for (const e of fsClient.readdirSync(d, { withFileTypes: true })) {
        const p = d + "/" + e.name;
        if (e.isSymbolicLink()) outputs.push([p, 0, fsClient.readlinkSync(p)]);
        else if (e.isDirectory()) walk(p);
        else outputs.push([p, fsClient.statSync(p).size]);
      }
    };
    try { walk(data.appDir + "/.next"); } catch {}
    log(`next exited with code ${code}; .next holds ${outputs.length} files; pool grew to ${pool.workers.length} threads`);
    // Hand .next to the page for display and download.
    const blobs = outputs.map(([p, , link]) => (link ? new TextEncoder().encode(link) : fsClient.readFileBytes(p)));
    const files = outputs.map(([p, , link], i) => [p.slice(data.appDir.length + 1), blobs[i], link]);
    self.postMessage({ type: "dotnext", files }, blobs.map((b) => b.buffer));
    pool.stop();
    self.postMessage({ type: "done", ok: code === 0, code, error: error && String(error.stack || error), buildSeconds: (performance.now() - tStart) / 1000, outputs });
  };
  const onFailure = (e) => {
    if (e instanceof rt.ProcessExit) return finish(e.code);
    log("uncaught:", e && (e.stack || e));
  };
  self.addEventListener("unhandledrejection", (ev) => { ev.preventDefault(); onFailure(ev.reason); });
  self.addEventListener("error", (ev) => { ev.preventDefault(); onFailure(ev.error); });

  const tStart = performance.now();
  log("running next", data.args.join(" "));
  try {
    rt.runMain(data.appDir + "/node_modules/next/dist/bin/next");
  } catch (e) {
    onFailure(e);
  }
};
