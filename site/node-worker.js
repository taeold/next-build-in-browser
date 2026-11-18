// A real worker_threads thread: its own Node.js layer (node/runtime.js) on its own client of the file system worker.
// The first message carries the setup: `link` talks to whoever created this thread (parentPort), `service` to the
// root thread, which creates any threads this one starts (threads.js).
import { createFsClient } from "./fs-client.js";
import { createRuntime } from "./node/runtime.js";

self.addEventListener("message", function init(e) {
  const d = e.data && e.data.nodeWorker;
  if (!d) return;
  self.removeEventListener("message", init);
  const { link, service } = d;
  const report = (err) => link.postMessage({ __nodeError: { message: String(err && err.message || err), stack: err && err.stack, name: err && err.name } });
  self.addEventListener("error", (ev) => { ev.preventDefault(); report(ev.error || ev.message); });
  self.addEventListener("unhandledrejection", (ev) => { ev.preventDefault(); report(ev.reason); });
  link.addEventListener("message", (ev) => { if (ev.data && ev.data.__nodeTerminate) self.close(); });
  // Node code expects `self` and `onmessage` to be plain properties (napi-rs's wasi-worker.mjs assigns both); in a Web
  // Worker `self` is read-only and setting `onmessage` would subscribe to this worker's own messages.
  for (const name of ["self", "onmessage"]) Object.defineProperty(globalThis, name, { value: name === "self" ? globalThis : null, writable: true, configurable: true, enumerable: true });
  const rt = createRuntime({
    fs: createFsClient(d.fsPort, d.regPort), cwd: d.cwd, polyfills: d.polyfills, env: d.env, argv: d.argv, redirects: d.redirects,
    write: (fd, text) => service.postMessage({ stdio: [fd, text] }),
    // This thread has no compiler; its creator compiled the ES modules it loads (see compileThreadGraph).
    transformEsm: (source, filename) => {
      if (filename in d.transformed) return d.transformed[filename];
      throw new Error(`cannot compile ES module ${filename} in a worker thread`);
    },
    spawnWorker: (init) => {
      const child = new MessageChannel();
      service.postMessage({ spawn: init, link: child.port2 }, [child.port2]);
      return child.port1;
    },
    worker: { workerData: d.workerData, threadId: d.threadId, port: { postMessage: (m, t) => link.postMessage(m, t), addEventListener: (type, f) => { link.addEventListener(type, f); link.start(); } } },
  });
  rt.installGlobals();
  try {
    rt.runMain(d.filename);
  } catch (err) {
    if (err instanceof rt.ProcessExit) link.postMessage({ __nodeExit: err.code });
    else report(err);
  }
});
