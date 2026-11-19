// Runs one command of a build script (next build, vite build, ...) as a Node.js process on the layer in
// node/runtime.js. The page starts a fresh worker for each command, so each one gets a clean process.
import { createFsClient } from "./fs-client.js";
import { loadCompiler } from "./commonjs.js";
import { startThreads } from "./threads.js";
import { createRuntime } from "./node/runtime.js";

const post = (type, text) => self.postMessage({ type, text });

// VERCEL=1 asks frameworks with a Vercel adapter (Nuxt, SvelteKit's adapter-auto) for Build Output API v3, as on
// Vercel's build machines. Next.js keeps its standalone output, which deploy.js turns into Build Output itself.
// Commands that need more than their bin run as is. `exit: "explicit"` waits for process.exit(): the runtime cannot
// see every pending native call (a binding's thread-safe functions), so ending when idle could cut such a CLI short.
const RULES = {
  next: (c) => (c.args[0] === "build" ? { args: [...c.args, "--wasi", "--experimental-build-mode", "compile"], env: { NEXT_PRIVATE_STANDALONE: "1" }, exit: "explicit", vercel: false } : {}),
  astro: (c) => (c.args[0] === "build" ? { exit: "explicit" } : {}),
  tsc: (c, version) => (parseInt(version("typescript")) >= 7 ? { skip: "TypeScript 7 is a native binary; type check skipped" } : {}),
};

let started;
self.onmessage = async ({ data }) => {
  if (data.type === "start") {
    const fsClient = createFsClient(data.fsPort, data.regPort);
    started = Promise.all([loadCompiler(), startThreads(fsClient)]).then(([toCommonJs, threads]) => { self.postMessage({ type: "ready" }); return { fsClient, toCommonJs, threads }; },
      (e) => { self.postMessage({ type: "done", code: -1, error: String(e && (e.stack || e)) }); throw e; });
    return;
  }
  if (data.type !== "run") return;
  const { fsClient, toCommonJs, threads } = await started;
  const { appDir } = data;
  const exists = (p) => { try { fsClient.statSync(p); return true; } catch { return false; } };
  const version = (pkg) => { try { return JSON.parse(new TextDecoder().decode(fsClient.readFileBytes(`${appDir}/node_modules/${pkg}/package.json`))).version; } catch { return ""; } };

  const rule = (RULES[data.bin] || (() => ({})))(data, version);
  const cmd = { ...data, ...rule, env: { ...data.env, ...rule.env } };
  if (cmd.skip) { self.postMessage({ type: "argv", text: [cmd.bin, ...cmd.args].join(" ") }); post("out", cmd.skip); return self.postMessage({ type: "done", code: 0 }); }
  // `node file.js` runs the file; any other command is a package's bin in node_modules/.bin.
  const [entry, args] = cmd.bin === "node" ? [`${appDir}/${cmd.args[0]}`, cmd.args.slice(1)] : [`${appDir}/node_modules/.bin/${cmd.bin}`, cmd.args];
  if (!exists(entry)) { post("out", `${cmd.bin}: command not found`); return self.postMessage({ type: "done", code: 127 }); }
  const main = fsClient.realpathSync(entry);
  self.postMessage({ type: "argv", text: [cmd.bin, ...cmd.args].join(" ") });

  let stdoutBuf = "";
  const write = (fd, s) => {
    stdoutBuf += s;
    let i;
    while ((i = stdoutBuf.indexOf("\n")) >= 0) { post("out", stdoutBuf.slice(0, i).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")); stdoutBuf = stdoutBuf.slice(i + 1); }
  };
  // Packages whose WebAssembly build is a separate package (the installer adds it next to them).
  const redirects = { lightningcss: "lightningcss-wasm", rollup: "@rollup/wasm-node" };
  const spawnWorker = threads({ cwd: appDir, polyfills: data.polyfills, redirects }, write);
  const rt = createRuntime({
    fs: fsClient, cwd: appDir, polyfills: data.polyfills, write, redirects, spawnWorker, toCommonJs,
    env: { HOME: "/home/user", PATH: "/usr/bin", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", NUXT_TELEMETRY_DISABLED: "1", TURBO_TASKS_AVAILABLE_PARALLELISM: String(data.parallelism), ...(cmd.vercel !== false && { VERCEL: "1" }), ...cmd.env },
    argv: ["/usr/bin/node", main, ...args],
    onExit: (code) => finish(code),
  });
  // emnapi captured Buffer when its context was created, before the runtime installed the polyfill; Turbopack's loader
  // workers exchange messages as Buffers.
  rt.installGlobals();

  const t0 = performance.now();
  let finished = false;
  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    if (stdoutBuf) post("out", stdoutBuf);
    self.postMessage({ type: "done", code, error: error && String(error.stack || error), seconds: (performance.now() - t0) / 1000 });
  };
  const onFailure = (e) => {
    if (e instanceof rt.ProcessExit) return finish(e.code);
    post("log", "uncaught: " + (e && (e.stack || (typeof e === "object" ? JSON.stringify(e) : e))));
  };
  self.addEventListener("unhandledrejection", (ev) => { ev.preventDefault(); onFailure(ev.reason); });
  self.addEventListener("error", (ev) => { ev.preventDefault(); onFailure(ev.error); });
  try {
    rt.runMain(main);
    // A CLI that returns without process.exit() ends, as in Node, when nothing holds the event loop open.
    if (cmd.exit !== "explicit") rt.whenIdle().then((code) => { rt.process.emit("exit", code); finish(code); });
  } catch (e) {
    onFailure(e);
  }
};
