// Instantiates @next/swc-wasm-wasi (Turbopack + SWC) in this worker with a pre-started thread pool and returns
// its N-API exports. Shared by the replay host and the next-build host.
import * as emnapi from "/pkg/emnapi-core.mjs";
import { getDefaultContext } from "/pkg/emnapi-runtime.mjs";
import { decompressed } from "./decompress.js";
import { createImportedMemory, createWasi, createImportObject, createThreadPool } from "./wasi-host.js";

export async function createBinding({ fsClient, wasmUrl, parallelism, life }) {
  const res = await fetch(wasmUrl);
  const module = /\.(gz|br)$/.test(wasmUrl)
    ? await WebAssembly.compile(await new Response(decompressed(res.body, wasmUrl)).arrayBuffer())
    : await WebAssembly.compileStreaming(res);
  const workerData = { life, args: ["next"], env: { TURBO_TASKS_AVAILABLE_PARALLELISM: String(parallelism), NODE_ENV: "production" }, preopens: { "/": "/" } };
  const napiModule = emnapi.createNapiModule({ context: getDefaultContext(), asyncWorkPoolSize: 0 });
  const wasi = createWasi(fsClient, workerData);
  const memory = createImportedMemory();
  const pool = createThreadPool({ module, memory, fsClient, workerData, napiModule });
  await pool.ready();
  const imports = createImportObject({ module, memory, napiImports: napiModule.imports, wasiImports: wasi.getImportObject(), threadSpawn: pool.threadSpawn });
  const instance = await WebAssembly.instantiate(module, imports);
  wasi.initialize(instance);
  for (const [name, register] of Object.entries(instance.exports)) if (name.startsWith("__napi_register__")) register();
  napiModule.init({ instance, module, memory });
  return { exports: napiModule.exports, pool };
}
