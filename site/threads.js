// The root's side of worker_threads: it creates every thread's Web Worker, because a Web Worker created by a thread
// that is busy (blocked in wasm) never starts, and the root is never blocked. Each thread gets a link (a MessagePort
// whose other end belongs to whoever called new Worker) and a service port back to the root, for nested threads, for
// console output, and for compiling ES modules: the compiler (SWC in the binding) lives on the root.
import { portsForChild } from "./fs-client.js";

export function createThreadHost({ fsClient, setup, write, transformEsm }) {
  const encoder = new TextEncoder();
  const serve = (service) => {
    service.onmessage = ({ data }) => {
      if (data.stdio) write(data.stdio[0], data.stdio[1]);
      if (data.spawn) start(data.spawn, data.link, data.transfer);
      if (data.compile) compile(data.compile, data.reply);
    };
  };
  // Answers a thread blocked in compileOnRoot (node-worker.js): reply is [state, length, ...utf8], state 1 for code,
  // 2 for an error message. A result that does not fit only reports its length; the thread asks again.
  const compile = ({ source, filename }, reply) => {
    const header = new Int32Array(reply, 0, 2);
    let bytes, state = 1;
    try { bytes = encoder.encode(transformEsm(source, filename)); }
    catch (err) { bytes = encoder.encode(String(err && err.stack || err)); state = 2; }
    header[1] = bytes.length;
    if (bytes.length <= reply.byteLength - 8) new Uint8Array(reply, 8).set(bytes);
    Atomics.store(header, 0, state);
    Atomics.notify(header, 0);
  };
  const start = (init, link, transfer = []) => {
    const thread = new Worker(new URL("./node-worker.js", import.meta.url), { type: "module", name: "node-worker" });
    const [fsPort, regPort] = portsForChild(fsClient);
    const service = new MessageChannel();
    serve(service.port1);
    thread.postMessage({ nodeWorker: { ...setup, ...init, fsPort, regPort, link, service: service.port2 } }, [fsPort, regPort, link, service.port2, ...transfer]);
  };
  // spawnWorker for the root's own runtime: returns the parent's end of the new thread's link.
  return (init, transfer) => {
    const link = new MessageChannel();
    start(init, link.port2, transfer);
    return link.port1;
  };
}
