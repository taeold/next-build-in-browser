// Browser port of Next's WASI loader (next/dist/build/swc/wasi-loader.js + wasi-runtime.js): Web Workers instead of
// worker_threads, @tybys/wasm-util's WASI over fs-client.js instead of node:wasi. Every thread worker can spawn its
// own threads, like Next's Node host, sharing one thread-id counter.
import { WASI } from "/wasm-util.js";
import { ThreadManager } from "/pkg/wasi-threads.mjs";
import { portsForChild } from "./fs-client.js";

const PAGE = 65536;
export const createImportedMemory = () =>
  new WebAssembly.Memory({ initial: 536870912 / PAGE, maximum: 4294967296 / PAGE, shared: true });

export function createReadCustomSection(module, memory) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return (namePtr, nameLength, targetPtr, targetLength) => {
    const name = decoder.decode(new Uint8Array(memory.buffer, namePtr, nameLength).slice());
    const sections = WebAssembly.Module.customSections(module, name);
    if (sections.length === 0) return 0;
    if (sections.length !== 1) throw new Error(`custom section ${JSON.stringify(name)} is ambiguous`);
    const section = new Uint8Array(sections[0]);
    if (targetLength < section.byteLength) return section.byteLength;
    new Uint8Array(memory.buffer, targetPtr, section.byteLength).set(section);
    return section.byteLength;
  };
}

export function createWasi(fsClient, data) {
  return makeWasi(fsClient, data);
}
function makeWasi(fsClient, data) {
  return new WASI({
    version: "preview1", args: data.args, env: data.env, preopens: data.preopens, fs: fsClient, returnOnExit: true,
    print: (s) => console.log(String(s).trimEnd()), printErr: (s) => console.warn(String(s).trimEnd()),
  });
}

export function createImportObject({ module, memory, napiImports, wasiImports, threadSpawn }) {
  return {
    ...napiImports,
    ...wasiImports,
    env: { ...(napiImports.napi ?? {}), ...(napiImports.env ?? {}), memory, read_custom_section: createReadCustomSection(module, memory) },
    wasi: { ...(wasiImports.wasi ?? {}), "thread-spawn": threadSpawn },
  };
}

export function initializeWasiThread(wasi, instance) {
  const exports = { ...instance.exports };
  delete exports._start;
  delete exports._initialize;
  wasi.initialize({ exports });
}

// Mailbox slot layout (Int32): [state, tid, startArg, unused]. state: -2 loading, 0 idle, -1 claimed, 1 job posted.
export const SLOT = 4, MAX_THREADS = 128;
export const createMailbox = () => new Int32Array(new SharedArrayBuffer(MAX_THREADS * SLOT * 4)).fill(-2);

// wasi `thread-spawn`, callable from any thread: claims an idle, already-started pool worker and hands it the
// thread synchronously. A new Web Worker cannot start while its creator is blocked, so nothing is created here.
export function makeThreadSpawn(mailbox, threadIds, onClaim) {
  return (startArg) => {
    for (let i = 0; i < MAX_THREADS; i++) {
      const at = i * SLOT;
      if (Atomics.compareExchange(mailbox, at, 0, -1) !== 0) continue;
      const tid = Atomics.add(threadIds, 0, 1) + 1;
      if (onClaim) onClaim(i, tid);
      mailbox[at + 1] = tid;
      mailbox[at + 2] = startArg;
      Atomics.store(mailbox, at, 1);
      Atomics.notify(mailbox, at);
      return tid;
    }
    console.error("wasi thread pool exhausted");
    return -1;
  };
}

// Host side: pre-started pool workers, topped up from the host's event loop whenever few are idle.
export function createThreadPool({ module, memory, fsClient, workerData, napiModule, initial = 8, minIdle = 4 }) {
  const mailbox = createMailbox();
  const threadIds = new Int32Array(new SharedArrayBuffer(4));
  const workers = [];
  const add = () => {
    const index = workers.length;
    if (index >= MAX_THREADS) return;
    const worker = new Worker(new URL("./thread-worker.js", import.meta.url), { type: "module", name: `wasi-thread-${index}` });
    const [fsPort, regPort] = portsForChild(fsClient);
    napiModule.emnapi.addSendListener(worker);
    worker.postMessage({ vvInit: { fsPort, regPort, workerData, module, memory, mailbox, threadIds, index } }, [fsPort, regPort]);
    workers.push(worker);
  };
  for (let i = 0; i < initial; i++) add();
  const idle = () => { let n = 0; for (let i = 0; i < workers.length; i++) if (Atomics.load(mailbox, i * SLOT) === 0) n++; return n; };
  const loading = () => { let n = 0; for (let i = 0; i < workers.length; i++) if (Atomics.load(mailbox, i * SLOT) === -2) n++; return n; };
  const timer = setInterval(() => { if (idle() + loading() < minIdle) add(); }, 20);
  const ready = () => new Promise((resolve) => { const t = setInterval(() => { if (loading() === 0) { clearInterval(t); resolve(); } }, 10); });
  // emnapi looks threads up by tid on the main instance (e.g. for its async-work pool), so register each claim.
  const threadSpawn = makeThreadSpawn(mailbox, threadIds, (i, tid) => { if (napiModule.PThread) napiModule.PThread.pthreads[tid] = workers[i]; });
  return { threadSpawn, ready, workers, stop: () => clearInterval(timer), idle };
}
