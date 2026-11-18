// The root's side of worker_threads: it creates every thread's Web Worker, because a Web Worker created by a thread
// that is busy (blocked in wasm) never starts, and the root is never blocked. Each thread gets a link (a MessagePort
// whose other end belongs to whoever called new Worker) and a service port back to the root, for nested threads and
// for console output.
import { portsForChild } from "./fs-client.js";

export function createThreadHost({ fsClient, setup, write }) {
  const serve = (service) => {
    service.onmessage = ({ data }) => {
      if (data.stdio) write(data.stdio[0], data.stdio[1]);
      if (data.spawn) start(data.spawn, data.link);
    };
  };
  const start = (init, link) => {
    const thread = new Worker(new URL("./node-worker.js", import.meta.url), { type: "module", name: "node-worker" });
    const [fsPort, regPort] = portsForChild(fsClient);
    const service = new MessageChannel();
    serve(service.port1);
    thread.postMessage({ nodeWorker: { ...setup, ...init, fsPort, regPort, link, service: service.port2 } }, [fsPort, regPort, link, service.port2]);
  };
  // spawnWorker for the root's own runtime: returns the parent's end of the new thread's link.
  return (init) => {
    const link = new MessageChannel();
    start(init, link.port2);
    return link.port1;
  };
}
