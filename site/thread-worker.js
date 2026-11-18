// One wasm thread for binding.js: emnapi's MessageHandler, with this worker's own client of the file system worker.
import { MessageHandler, instantiateNapiModuleSync } from "/pkg/emnapi-core.mjs";
import { createFsClient } from "./fs-client.js";
import { createWasi, napiEnv } from "./wasi-host.js";

let fsClient, workerData;
const handler = new MessageHandler({
  onLoad: ({ wasmModule, wasmMemory }) =>
    instantiateNapiModuleSync(wasmModule, {
      childThread: true,
      wasi: createWasi(fsClient, workerData),
      overwriteImports: (imports) => napiEnv(imports, wasmModule, wasmMemory),
    }),
  onError: (err) => console.error("wasi thread error:", err && (err.stack || err)),
});
self.onmessage = (e) => {
  if (e.data && e.data.fsInit) {
    ({ workerData } = e.data.fsInit);
    fsClient = createFsClient(e.data.fsInit.fsPort, e.data.fsInit.regPort);
    return;
  }
  handler.handle(e);
};
