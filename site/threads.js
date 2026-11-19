// The root's side of worker_threads. Threads start in spawner.js, which also compiles their modules; the root only
// prints their console output. Each thread gets a link (a MessagePort whose other end belongs to whoever called
// new Worker) and a service port to the spawner, for nested threads and for compiling.
import { portsForChild } from "./fs-client.js";

// Resolves, once the spawner runs, with spawnWorker for a runtime's options. The root waits for it before running
// anything that might block: a Web Worker never starts while its creator is blocked.
export function startThreads(fsClient) {
  const spawner = new Worker(new URL("./spawner.js", import.meta.url), { type: "module", name: "spawner" });
  return new Promise((resolve) => {
    spawner.onmessage = () => {
      spawner.onmessage = null;
      resolve((setup, write) => {
        const stdio = new MessageChannel();
        stdio.port1.onmessage = ({ data }) => write(data[0], data[1]);
        const [, registrar] = portsForChild(fsClient);
        spawner.postMessage({ setup, stdio: stdio.port2, registrar }, [stdio.port2, registrar]);
        // spawnWorker: returns the parent's end of the new thread's link.
        return (init, transfer = []) => {
          const link = new MessageChannel();
          spawner.postMessage({ spawn: init, link: link.port2, transfer }, [link.port2, ...transfer]);
          return link.port1;
        };
      });
    };
  });
}
