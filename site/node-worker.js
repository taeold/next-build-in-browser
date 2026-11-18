// A real worker_threads thread: its own Node.js layer (node/runtime.js) on its own client of the file system worker.
// The first message carries the setup; after that the runtime's parentPort owns this worker's message channel.
import { createFsClient } from "./fs-client.js";
import { createRuntime } from "./node/runtime.js";

// The browser's own message channel, captured before Node code can replace globals. Node code expects `self` and
// `onmessage` to be plain properties (napi-rs's wasi-worker.mjs assigns both); in a Web Worker `self` is read-only
// and setting `onmessage` would also subscribe to the parent's messages a second time.
const port = { postMessage: self.postMessage.bind(self), addEventListener: self.addEventListener.bind(self) };
const removeListener = self.removeEventListener.bind(self);

port.addEventListener("message", function init(e) {
  const d = e.data && e.data.nodeWorker;
  if (!d) return;
  removeListener("message", init);
  for (const name of ["self", "onmessage"]) Object.defineProperty(globalThis, name, { value: name === "self" ? globalThis : null, writable: true, configurable: true, enumerable: true });
  const rt = createRuntime({
    fs: createFsClient(d.fsPort, d.regPort), cwd: d.cwd, polyfills: d.polyfills, env: d.env, argv: d.argv, redirects: d.redirects,
    write: (fd, text) => port.postMessage({ __nodeStdio: [fd, text] }),
    // This thread has no compiler; the parent compiled the entry if it is an ES module.
    transformEsm: (source, filename) => {
      if (filename in d.transformed) return d.transformed[filename];
      throw new Error(`cannot compile ES module ${filename} in a worker thread`);
    },
    worker: { workerData: d.workerData, threadId: d.threadId, port },
  });
  rt.installGlobals();
  try {
    rt.runMain(d.filename);
  } catch (err) {
    if (err instanceof rt.ProcessExit) port.postMessage({ __nodeExit: err.code });
    else throw err;
  }
});
