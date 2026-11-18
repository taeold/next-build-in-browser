// A pool worker: instantiates the module on the shared memory once, then runs wasm threads handed to it through
// its mailbox slot, one after another, never returning to the event loop.
import * as emnapi from "/pkg/emnapi-core.mjs";
import { createFsClient } from "./fs-client.js";
import { createWasi, createImportObject, initializeWasiThread, makeThreadSpawn, SLOT } from "./wasi-host.js";

self.onmessage = async (e) => {
  if (!(e.data && e.data.vvInit)) return;
  const { fsPort, regPort, workerData, module, memory, mailbox, threadIds, index } = e.data.vvInit;
  const life = workerData.life;
  Atomics.add(life, 0, 1);
  const fsClient = createFsClient(fsPort, regPort);
  const wasi = createWasi(fsClient, workerData);
  const napiModule = emnapi.createNapiModule({ childThread: true, postMessage: (m) => self.postMessage(m) });
  const threadSpawn = makeThreadSpawn(mailbox, threadIds);
  const imports = createImportObject({ module, memory, napiImports: napiModule.imports, wasiImports: wasi.getImportObject(), threadSpawn });
  const instance = await WebAssembly.instantiate(module, imports);
  initializeWasiThread(wasi, instance);
  napiModule.init({ instance, module, memory });
  Atomics.add(life, 1, 1);
  const at = index * SLOT;
  Atomics.store(mailbox, at, 0);
  for (;;) {
    const state = Atomics.load(mailbox, at);
    if (state !== 1) { Atomics.wait(mailbox, at, state); continue; }
    const tid = mailbox[at + 1], arg = mailbox[at + 2];
    Atomics.add(life, 2, 1);
    try {
      instance.exports.wasi_thread_start(tid, arg);
    } catch (err) {
      if (err !== "unwind") console.error(`wasi thread ${tid} trapped:`, err && (err.stack || err));
    }
    Atomics.add(life, 3, 1);
    Atomics.store(mailbox, at, 0);
  }
};
