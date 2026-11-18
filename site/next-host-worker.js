// Runs a framework's build CLI (next build --wasi, vite build, ...) in this worker on the Node.js layer in
// node/runtime.js. The CLI loads its own wasm tooling, as on Node.
import { createFsClient } from "./fs-client.js";
import { createThreadHost } from "./threads.js";
import { createRuntime } from "./node/runtime.js";

// SWC's standalone wasm build compiles ES modules to CommonJS for require(): on this thread, and for worker threads
// through threads.js. Pinned, from jsDelivr's npm mirror.
const SWC = "https://cdn.jsdelivr.net/npm/@swc/wasm-web@1.16.22/wasm.js";
const swcReady = import(SWC).then(async (swc) => { await swc.default(); return swc; });

const t0 = performance.now();
const sec = () => ((performance.now() - t0) / 1000).toFixed(2) + "s";
const post = (type, text) => self.postMessage({ type, text });
const log = (...a) => post("log", `[host +${sec()}] ${a.join(" ")}`);

// "start" connects the file system and loads SWC while the user picks an app; "run" starts the CLI once the app is in
// the file system. Next.js loads its WASI binding itself (next build --wasi), as on Node.
let started;
self.onmessage = async ({ data }) => {
  if (data.type === "start") {
    const fsClient = createFsClient(data.fsPort, data.regPort);
    started = swcReady.then(() => { self.postMessage({ type: "ready" }); return { fsClient }; },
      (e) => { self.postMessage({ type: "done", ok: false, code: -1, error: String(e && (e.stack || e)) }); throw e; });
    return;
  }
  if (data.type !== "run") return;
  const { fsClient } = await started;
  const swc = await swcReady;

  let stdoutBuf = "";
  const write = (fd, s) => {
    stdoutBuf += s;
    let i;
    while ((i = stdoutBuf.indexOf("\n")) >= 0) { post("out", stdoutBuf.slice(0, i).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")); stdoutBuf = stdoutBuf.slice(i + 1); }
  };
  const redirects = { lightningcss: "lightningcss-wasm", "@tailwindcss/oxide": "/polyfills/node_modules/@vv/tailwind-oxide-js/index.js" };
  // require() of an ES module (Node 22+), compiled to CommonJS. "swc" interop honors __esModule, so a default import
  // of another compiled ES module gets its default export.
  const transformEsm = (source, filename) => swc.transformSync(source, {
    filename, isModule: true, sourceMaps: false,
    jsc: { parser: { syntax: "ecmascript", importAttributes: true }, target: "es2022" },
    module: { type: "commonjs", importInterop: "swc" },
  }).code;
  const spawnWorker = createThreadHost({ fsClient, setup: { cwd: data.appDir, polyfills: data.polyfills, redirects }, write, transformEsm });
  const rt = createRuntime({
    fs: fsClient, cwd: data.appDir, polyfills: data.polyfills, write,
    // Native packages Tailwind needs: lightningcss has an official wasm build; oxide gets a JS scanner (see the file).
    redirects,
    // worker_threads get real threads (node-worker.js, created by threads.js).
    spawnWorker,
    transformEsm,
    env: { HOME: "/home/user", PATH: "/usr/bin", NEXT_TELEMETRY_DISABLED: "1", TURBO_TASKS_AVAILABLE_PARALLELISM: String(data.parallelism), ...data.env },
    argv: ["/usr/bin/node", data.appDir + "/" + (data.bin || "node_modules/next/dist/bin/next"), ...data.args],
  });

  // emnapi captured Buffer when its context was created, before the runtime installed the polyfill; Turbopack's loader
  // workers exchange messages as Buffers.
  rt.installGlobals();

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
    try { walk(data.appDir + "/" + (data.outDir || ".next")); } catch {}
    log(`exited with code ${code}; ${outputs.length} output files`);
    // Hand .next to the page for display and download.
    const blobs = outputs.map(([p, , link]) => (link ? new TextEncoder().encode(link) : fsClient.readFileBytes(p)));
    const files = outputs.map(([p, , link], i) => [p.slice(data.appDir.length + 1), blobs[i], link]);
    self.postMessage({ type: "dotnext", files }, blobs.map((b) => b.buffer));
    self.postMessage({ type: "done", ok: code === 0, code, error: error && String(error.stack || error), buildSeconds: (performance.now() - tStart) / 1000, outputs });
  };
  const onFailure = (e) => {
    if (e instanceof rt.ProcessExit) return finish(e.code);
    log("uncaught:", e && (e.stack || e));
  };
  self.addEventListener("unhandledrejection", (ev) => { ev.preventDefault(); onFailure(ev.reason); });
  self.addEventListener("error", (ev) => { ev.preventDefault(); onFailure(ev.error); });

  const tStart = performance.now();
  log("running", data.bin || "next", data.args.join(" "));
  try {
    rt.runMain(data.appDir + "/" + (data.bin || "node_modules/next/dist/bin/next"));
    // A CLI that returns without process.exit() ends, as in Node, when nothing holds the event loop open.
    if (data.exitOnIdle) rt.whenIdle().then((code) => { rt.process.emit("exit", code); finish(code); });
  } catch (e) {
    onFailure(e);
  }
};
