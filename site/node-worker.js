// A real worker_threads thread: its own Node.js layer (node/runtime.js) on its own client of the file system worker.
// The first message carries the setup: `link` talks to whoever created this thread (parentPort), `service` to the
// spawner, which starts any threads this one starts and compiles its modules, and passes console output to the root.
import { createFsClient } from "./fs-client.js";
import { createRuntime } from "./node/runtime.js";

self.addEventListener("message", function init(e) {
  const d = e.data && e.data.nodeWorker;
  if (!d) return;
  self.removeEventListener("message", init);
  const { link, service } = d;
  let rt;
  // process.exit() already reported itself (onExit); its throw is not an error.
  const report = (err) => (rt && err instanceof rt.ProcessExit) || link.postMessage({ __nodeError: { message: String(err && err.message || err), stack: err && err.stack, name: err && err.name } });
  self.addEventListener("error", (ev) => { ev.preventDefault(); report(ev.error || ev.message); });
  self.addEventListener("unhandledrejection", (ev) => { ev.preventDefault(); report(ev.reason); });
  link.addEventListener("message", (ev) => { if (ev.data && ev.data.__nodeTerminate) self.close(); });
  // Node code expects `self` and `onmessage` to be plain properties (napi-rs's wasi-worker.mjs assigns both), and no
  // global postMessage (Emscripten's threads only use parentPort without one). In a Web Worker `self` is read-only,
  // setting `onmessage` would subscribe to this worker's own messages, and postMessage would reach the spawner.
  for (const [name, value] of [["self", globalThis], ["onmessage", null], ["postMessage", undefined]]) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
  rt = createRuntime({
    fs: createFsClient(d.fsPort, d.regPort), cwd: d.cwd, polyfills: d.polyfills, env: d.env, argv: d.argv, redirects: d.redirects,
    write: (fd, text) => service.postMessage({ stdio: [fd, text] }),
    onExit: (code) => link.postMessage({ __nodeExit: code }),
    // The spawner compiles, on request, every ES module and any CommonJS that may call import().
    toCommonJs: (source, filename, esm) => (esm || /\bimport\s*\(/.test(source) ? compileRemote(service, source, filename, esm) : source),
    spawnWorker: (init, transfer = []) => {
      const child = new MessageChannel();
      service.postMessage({ spawn: init, link: child.port2, transfer }, [child.port2, ...transfer]);
      return child.port1;
    },
    worker: { workerData: d.workerData, threadId: d.threadId, port: { postMessage: (m, t) => link.postMessage(m, t), addEventListener: (type, f) => { link.addEventListener(type, f); link.start(); } } },
  });
  rt.installGlobals();
  try {
    rt.runMain(d.filename);
  } catch (err) {
    if (!(err instanceof rt.ProcessExit)) report(err);
  }
});

// Blocks until the spawner compiles `source`, like a synchronous require.
function compileRemote(service, source, filename, esm) {
  for (let size = source.length * 4 + 65536; ;) {
    const reply = new SharedArrayBuffer(8 + size), header = new Int32Array(reply, 0, 2);
    service.postMessage({ compile: { source, filename, esm }, reply });
    Atomics.wait(header, 0, 0);
    const length = header[1];
    if (length > size) { size = length; continue; }
    const text = new TextDecoder().decode(new Uint8Array(reply, 8, length).slice());
    if (Atomics.load(header, 0) === 2) throw new Error(text);
    return text;
  }
}
