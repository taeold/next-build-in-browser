// Loads @next/swc-wasm-wasi (Turbopack + SWC) in this worker the way napi-rs's browser loader does: emnapi's
// instantiateNapiModule, with each wasm thread on a Web Worker (thread-worker.js). The one difference is the file
// system: every thread gets its own synchronous client of the file system worker instead of a proxy to this thread.
import { instantiateNapiModule } from "/pkg/emnapi-core.mjs";
import { getDefaultContext } from "/pkg/emnapi-runtime.mjs";
import { decompressed } from "./decompress.js";
import { portsForChild } from "./fs-client.js";
import { createImportedMemory, createWasi, napiEnv } from "./wasi-host.js";

export async function createBinding({ fsClient, wasmUrl, parallelism }) {
  const res = await fetch(wasmUrl);
  const module = await WebAssembly.compile(await new Response(decompressed(res.body, wasmUrl)).arrayBuffer());
  const workerData = { args: ["next"], env: { TURBO_TASKS_AVAILABLE_PARALLELISM: String(parallelism), NODE_ENV: "production" }, preopens: { "/": "/" } };
  const memory = createImportedMemory();
  const { napiModule } = await instantiateNapiModule(module, {
    context: getDefaultContext(),
    wasi: createWasi(fsClient, workerData),
    asyncWorkPoolSize: 0,
    reuseWorker: true,
    onCreateWorker() {
      const worker = new Worker(new URL("./thread-worker.js", import.meta.url), { type: "module", name: "wasi-thread" });
      const [fsPort, regPort] = portsForChild(fsClient);
      worker.postMessage({ fsInit: { fsPort, regPort, workerData } }, [fsPort, regPort]);
      return worker;
    },
    overwriteImports: (imports) => napiEnv(imports, module, memory),
    beforeInit({ instance }) {
      for (const [name, register] of Object.entries(instance.exports)) if (name.startsWith("__napi_register__")) register();
    },
  });
  const threads = napiModule.PThread;
  return { exports: napiModule.exports, threadCount: () => threads.unusedWorkers.length + Object.keys(threads.pthreads).length };
}
