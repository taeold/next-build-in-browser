// Synchronous, Node-fs-shaped view of fs-worker.js for @tybys/wasm-util's WASI. Blocks with Atomics.wait,
// so it only works inside workers. `register(port)` hands a fresh server port to the fs worker so a
// worker can give the threads it spawns their own clients.

const BUF_BYTES = 16 << 20;

export function createFsClient(port, registrar) {
  const ctrl = new Int32Array(new SharedArrayBuffer(16));
  const buf = new Uint8Array(new SharedArrayBuffer(BUF_BYTES));
  port.postMessage({ hello: { ctrl, buf } });
  const dec = new TextDecoder();

  let seq = 0;
  function call(op, args) {
    const id = ++seq;
    port.postMessage({ op, args, id });
    // A notify for the previous reply can arrive after we already consumed it; only the flag says a reply is ready.
    while (Atomics.load(ctrl, 0) === 0) Atomics.wait(ctrl, 0, 0);
    const status = Atomics.load(ctrl, 1), len = Atomics.load(ctrl, 2), echoed = Atomics.load(ctrl, 3);
    Atomics.store(ctrl, 0, 0);
    if (echoed !== id) console.error(`FS RPC MISMATCH: sent #${id} ${op}(${JSON.stringify(args && args[0])}) got reply for #${echoed}`);
    if (status === 1) {
      const e = JSON.parse(dec.decode(buf.slice(0, len)));
      throw Object.assign(new Error(e.message), { code: e.code });
    }
    return status === 2 ? JSON.parse(dec.decode(buf.slice(0, len))) : len;
  }

  const toStats = (s, bigint) => {
    const num = bigint ? (v) => BigInt(Math.trunc(v)) : (v) => v;
    const ms = s.mtimeMs;
    return {
      dev: num(1), ino: num(s.ino), mode: num(s.mode), nlink: num(1), uid: num(0), gid: num(0), rdev: num(0),
      size: num(s.size), blksize: num(4096), blocks: num(Math.ceil(s.size / 512)),
      atimeMs: num(ms), mtimeMs: num(ms), ctimeMs: num(ms), birthtimeMs: num(ms),
      atimeNs: bigint ? BigInt(Math.trunc(ms)) * 1000000n : undefined,
      mtimeNs: bigint ? BigInt(Math.trunc(ms)) * 1000000n : undefined,
      ctimeNs: bigint ? BigInt(Math.trunc(ms)) * 1000000n : undefined,
      atime: new Date(ms), mtime: new Date(ms), ctime: new Date(ms), birthtime: new Date(ms),
      isFile: () => s.kind === "file", isDirectory: () => s.kind === "dir", isSymbolicLink: () => s.kind === "link",
      isBlockDevice: () => false, isCharacterDevice: () => false, isSocket: () => false, isFIFO: () => false,
    };
  };
  const plain = (op) => (...args) => call(op, args);

  return {
    openSync: (p, flags = "r") => call("openSync", [p, flags]),
    closeSync: plain("closeSync"),
    fstatSync: (fd, o) => toStats(call("fstatSync", [fd]), o && o.bigint),
    statSync: (p, o) => toStats(call("statSync", [p]), o && o.bigint),
    lstatSync: (p, o) => toStats(call("lstatSync", [p]), o && o.bigint),
    realpathSync: (p) => call("realpathSync", [p]),
    readlinkSync: plain("readlinkSync"),
    readdirSync: (p, o) => {
      const list = call("readdirSync", [p]);
      if (!(o && o.withFileTypes)) return list.map((e) => e.name);
      return list.map((e) => ({ name: e.name, isFile: () => e.kind === "file", isDirectory: () => e.kind === "dir", isSymbolicLink: () => e.kind === "link", isBlockDevice: () => false, isCharacterDevice: () => false, isSocket: () => false, isFIFO: () => false }));
    },
    mkdirSync: (p) => call("mkdirSync", [p]),
    rmdirSync: plain("rmdirSync"),
    unlinkSync: plain("unlinkSync"),
    renameSync: plain("renameSync"),
    ftruncateSync: plain("ftruncateSync"),
    utimesSync: (p, a, m) => call("utimesSync", [p, Number(a), Number(m)]),
    futimesSync: (fd, a, m) => call("futimesSync", [fd, Number(a), Number(m)]),
    fsyncSync: plain("fsyncSync"),
    fdatasyncSync: plain("fdatasyncSync"),
    symlinkSync: plain("symlinkSync"),
    linkSync: plain("linkSync"),
    readSync(fd, target, offset = 0, length = target.length - offset, position = null) {
      let total = 0;
      while (total < length) {
        const want = Math.min(length - total, BUF_BYTES);
        const pos = position == null ? null : Number(position) + total;
        const n = call("readSync", [fd, want, pos]);
        target.set(buf.subarray(0, n), offset + total);
        total += n;
        if (n < want) break;
      }
      return total;
    },
    writeSync(fd, source, offset = 0, length = source.length - offset, position = null) {
      const bytes = source.slice(offset, offset + length);
      return call("writeSync", [fd, bytes, position == null ? null : Number(position)]);
    },
    readFileBytes(p) { const n = call("readFileBytes", [p]); return buf.slice(0, n); },
    writeFileBytes: (p, bytes) => call("writeFileBytes", [p, bytes]),
    serverStats: () => call("stats", []),
    register(serverPort) { registrar.postMessage({ type: "register", port: serverPort }, [serverPort]); },
    registerRegistrar(serverPort) { registrar.postMessage({ type: "registrar", port: serverPort }, [serverPort]); },
  };
}

// Make a client pair for a worker about to be spawned: [clientPort, registrarPort] to transfer to it.
export function portsForChild(fsClient) {
  const rpc = new MessageChannel();
  fsClient.register(rpc.port2);
  const reg = new MessageChannel();
  fsClient.registerRegistrar(reg.port2);
  return [rpc.port1, reg.port1];
}
