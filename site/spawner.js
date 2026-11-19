// Starts worker_threads threads (node-worker.js) and compiles their modules. A Web Worker created by a thread that
// is blocked (in Atomics.wait, say, waiting for that very thread) never starts, and a blocked thread answers no
// requests; this worker runs no app code, so it never blocks.
import { loadCompiler } from "./commonjs.js";

let setup, stdio, registrar, compiler;
const encoder = new TextEncoder();

// A new client of the file system worker for a thread, through the registrar it gave this worker.
function fsPorts() {
  const rpc = new MessageChannel(), reg = new MessageChannel();
  registrar.postMessage({ type: "register", port: rpc.port2 }, [rpc.port2]);
  registrar.postMessage({ type: "registrar", port: reg.port2 }, [reg.port2]);
  return [rpc.port1, reg.port1];
}

function start(init, link, transfer = []) {
  const thread = new Worker(new URL("./node-worker.js", import.meta.url), { type: "module", name: "node-worker" });
  const [fsPort, regPort] = fsPorts();
  const service = new MessageChannel();
  service.port1.onmessage = onRequest;
  thread.postMessage({ nodeWorker: { ...setup, ...init, fsPort, regPort, link, service: service.port2 } }, [fsPort, regPort, link, service.port2, ...transfer]);
}

// Answers a thread blocked in compileRemote (node-worker.js): reply is [state, length, ...utf8], state 1 for code,
// 2 for an error message. A result that does not fit only reports its length; the thread asks again.
async function compile({ source, filename, esm }, reply) {
  const toCommonJs = await (compiler ||= loadCompiler());
  const header = new Int32Array(reply, 0, 2);
  let bytes, state = 1;
  try { bytes = encoder.encode(toCommonJs(source, filename, esm)); }
  catch (err) { bytes = encoder.encode(String(err && err.stack || err)); state = 2; }
  header[1] = bytes.length;
  if (bytes.length <= reply.byteLength - 8) new Uint8Array(reply, 8).set(bytes);
  Atomics.store(header, 0, state);
  Atomics.notify(header, 0);
}

function onRequest({ data }) {
  if (data.stdio) stdio.postMessage(data.stdio);
  if (data.spawn) start(data.spawn, data.link, data.transfer);
  if (data.compile) compile(data.compile, data.reply);
}

self.onmessage = (e) => {
  if (e.data.setup) ({ setup, stdio, registrar } = e.data);
  else onRequest(e);
};
self.postMessage("ready");
