// Page logic: boot the file system and the wasm build host, take a dropped app, run next build, then offer
// a temporary prebuilt deploy and a download. Everything prints into the terminal card.
import { toBuildOutput, deployPrebuilt } from "/deploy.js";

const $ = (id) => document.getElementById(id);
const IGNORE = /(^|\/)(node_modules|\.next|\.git|\.vercel|\.turbo|out|dist)(\/|$)/;
const screen = $("screen");

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function print(html, cls = "") {
  const row = document.createElement("div");
  if (cls) row.className = cls;
  row.innerHTML = html;
  screen.append(row);
  screen.scrollTop = screen.scrollHeight;
  return row;
}
const say = (text, cls) => print(esc(text), cls);
// Each entry is [label, onclick, mark] for a text button, or an element to show as is.
function actions(list) {
  const bar = $("actions");
  bar.replaceChildren();
  for (const entry of list) {
    if (entry instanceof Node) { bar.append(entry); continue; }
    const [label, fn, mark = "→"] = entry;
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset.mark = mark;
    b.onclick = fn;
    bar.append(b);
  }
}
// A browser that kills the tab for memory reloads it at the same URL. Remember what was running, so the
// page can say so instead of quietly starting the same ?example= build again.
const running = (what) => (what ? sessionStorage.setItem("running", what) : sessionStorage.removeItem("running"));
const interrupted = sessionStorage.getItem("running");
running(null);
const mib = (n) => (n / 1048576).toFixed(0) + "mib";
const again = ["build another app", () => { location.href = location.pathname; }];

// ---------- boot ----------
// The two big toolchain files come from jsDelivr, out of the repo's `assets` branch at a pinned commit
// (scripts/publish-assets.sh), so the page's own host serves only small files. A local server uses its copies.
const ASSETS = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "/assets" : "https://cdn.jsdelivr.net/gh/taeold/next-build-in-browser@43874e83f18f1d7a9246462eb45073f91c6f223d";
const toolchain = print("toolchain: loading", "faint");
const fsWorker = new Worker("/fs-worker.js", { type: "module", name: "fs" });
const fsReady = new Promise((resolve) => fsWorker.addEventListener("message", (e) => {
  if (e.data.type === "progress") toolchain.textContent = `toolchain: downloading ${mib(e.data.seen)}${e.data.total ? " / " + mib(e.data.total) : ""}`;
  if (e.data.type === "ready") resolve(e.data);
}));
// The WASI binding's wasm goes where Next.js's own loader reads it, in its package.
fsWorker.postMessage({ type: "init", packs: [`${ASSETS}/base.pack.br`], files: [[`${ASSETS}/next-swc.wasm.br`, "/app/node_modules/@next/swc-wasm-wasi/next-swc.wasm32-wasi.wasm"]], extraDirs: ["/app", "/tmp", "/home/user"] });

const root = new MessageChannel();
fsWorker.postMessage({ type: "registrar", port: root.port2 }, [root.port2]);
const rpc = new MessageChannel(), reg = new MessageChannel();
root.port1.postMessage({ type: "register", port: rpc.port2 }, [rpc.port2]);
root.port1.postMessage({ type: "registrar", port: reg.port2 }, [reg.port2]);

const host = new Worker("/next-host-worker.js", { type: "module", name: "next-build" });
const hostReady = new Promise((resolve) => host.addEventListener("message", (e) => e.data.type === "ready" && resolve(e.data)));
host.postMessage({ type: "start", fsPort: rpc.port1, regPort: reg.port1 }, [rpc.port1, reg.port1]);

// The app picker: the sample, then the gallery of Next.js examples (scripts/snapshot-examples.mjs).
const picker = document.createElement("select");
picker.setAttribute("aria-label", "app to build");
picker.append(new Option("sample app", ""));
const start = [["build", () => (picker.value ? example(picker.value) : sample())], picker, ["choose folder", () => $("folder").click()]];
print("drop a next.js app folder here", "dim");
actions(start);
// iPadOS reports a Mac user agent, so a touch-capable "Mac" counts as mobile too.
const mobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
$("mobile").hidden = !mobile;
if (!crossOriginIsolated) say("this browser has no cross-origin isolation, so the build can't run", "bad");
Promise.all([fsReady, hostReady]).then(([f]) => { toolchain.textContent = `toolchain: ready · ${f.files.toLocaleString()} files`; });

// ---------- reading an app ----------
async function readEntry(entry, prefix, out) {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (IGNORE.test(path)) return;
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push([path, new Uint8Array(await file.arrayBuffer())]);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await readEntry(child, path, out);
    }
  }
}
// The folder holding package.json is the app root, so dropping a parent folder also works.
function rootAt(files) {
  const pkgs = files.map(([p]) => p).filter((p) => p.endsWith("package.json")).sort((a, b) => a.split("/").length - b.split("/").length);
  if (!pkgs.length) throw new Error("no package.json in the dropped folder");
  const dir = pkgs[0].slice(0, -"package.json".length);
  return files.filter(([p]) => p.startsWith(dir)).map(([p, b]) => [p.slice(dir.length), b]);
}
// How to build each supported framework: the CLI to run (relative to the app), its arguments, and where output lands.
const FRAMEWORKS = [
// `output` says how the output deploys (deploy.js): "next" is a standalone server plus static files, "static" is files.
// `exit` says how the CLI ends: "explicit" calls process.exit(); "idle" returns and ends once nothing holds the event
// loop open. The runtime cannot see every pending native call (a binding's C thread-safe functions), so idle
// detection is only used for CLIs that need it.
  { name: "next", detect: (deps) => deps.next, bin: "node_modules/next/dist/bin/next", args: ["build", "--wasi", "--experimental-build-mode", "compile"], env: { NEXT_PRIVATE_STANDALONE: "1" }, outDir: ".next", output: "next", exit: "explicit" },
  { name: "vite", detect: (deps) => deps.vite, bin: "node_modules/vite/bin/vite.js", args: ["build"], env: {}, outDir: "dist", output: "static", exit: "idle" },
];
function checkApp(files) {
  const pkg = JSON.parse(new TextDecoder().decode(files.find(([p]) => p === "package.json")[1]));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const framework = FRAMEWORKS.find((f) => f.detect(deps));
  if (!framework) throw new Error("no supported framework in package.json (next or vite)");
  if (framework.name === "next" && !files.some(([p]) => /^(src\/)?(app|pages)\//.test(p))) throw new Error("no app/ or pages/ directory");
  return { name: pkg.name || "app", framework };
}

// ---------- npm install (in a worker, straight into the in-tab file system) ----------
function npmInstall(files) {
  const text = (name) => { const f = files.find(([p]) => p === name); return f ? new TextDecoder().decode(f[1]) : null; };
  const lock = text("package-lock.json");
  print(`<b>$ npm install</b>${lock ? ' <span class="faint">(from package-lock.json)</span>' : ""}`);
  const progress = print("", "faint");
  const worker = new Worker("/install-worker.js", { type: "module", name: "npm-install" });
  const rpc = new MessageChannel(), reg = new MessageChannel();
  root.port1.postMessage({ type: "register", port: rpc.port2 }, [rpc.port2]);
  root.port1.postMessage({ type: "registrar", port: reg.port2 }, [reg.port2]);
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") progress.textContent = data.text;
      if (data.type === "line") say(data.text, "faint");
      if (data.type !== "done") return;
      worker.terminate();
      if (!data.ok) { progress.remove(); reject(new Error(`npm install failed: ${data.error}`)); return; }
      progress.textContent = `added ${data.added} packages (${data.megabytes.toFixed(1)}mib) in ${data.seconds.toFixed(1)}s${data.skipped ? `, skipped ${data.skipped} optional` : ""}`;
      progress.className = "ok";
      resolve();
    };
    worker.postMessage({ type: "install", fsPort: rpc.port1, regPort: reg.port1, packageJson: text("package.json"), lockJson: lock }, [rpc.port1, reg.port1]);
  });
}

// ---------- build ----------
let app = null, output = [], buildId = "", buildSeconds = 0, busy = false;
async function build(files, label, title) {
  if (busy) return;
  busy = true;
  running("build");
  actions([]);
  try {
    files = rootAt(files);
    const { name: packageName, framework } = checkApp(files);
    const name = title || packageName;
    app = { files, name, framework };
    print(`<span class="faint">${esc(label)}:</span> ${esc(name)} <span class="faint">(${files.length} files)</span>`);
    await fsReady;
    await new Promise((resolve) => {
      const done = (e) => { if (e.data.type === "written") { fsWorker.removeEventListener("message", done); resolve(); } };
      fsWorker.addEventListener("message", done);
      fsWorker.postMessage({ type: "writeFiles", files: files.map(([p, b]) => ["/app/" + p, b]) });
    });
    await npmInstall(files);
    await hostReady;
    print(`<b>$ ${esc(framework.name)} ${esc(framework.args.join(" "))}</b>`);
    host.postMessage({ type: "run", appDir: "/app", polyfills: "/polyfills/node_modules", parallelism: 2, bin: framework.bin, args: framework.args, env: framework.env, outDir: framework.outDir, exitOnIdle: framework.exit === "idle" });
  } catch (e) {
    say(String(e.message || e), "bad");
    running(null);
    busy = false;
    actions(start);
  }
}

host.addEventListener("message", ({ data }) => {
  if (data.type === "out") say(data.text, /✓/.test(data.text) ? "ok" : /rror/.test(data.text) ? "bad" : "");
  if (data.type === "log" && /uncaught|failed/i.test(data.text)) say(data.text.replace(/^\[host \+[\d.]+s\] /, ""), "bad");
  if (data.type === "dotnext") output = data.files;
  if (data.type !== "done") return;
  running(null);
  // The build is over and the next one reloads the page, so free the wasm memory, its threads and the file
  // system now. Deploy and download only need the .next files already copied here.
  host.terminate();
  fsWorker.terminate();
  if (!data.ok) {
    say(`build failed${data.error ? ": " + data.error : ""}`, "bad");
    actions([again]);
    return;
  }
  buildSeconds = data.buildSeconds;
  // Next.js writes a build ID; for other builds the tab makes one, so the deployment's proof still names this build.
  const nextBuildId = output.find(([p]) => p === ".next/BUILD_ID");
  buildId = nextBuildId ? new TextDecoder().decode(nextBuildId[1]).trim() : crypto.randomUUID().slice(0, 8);
  const bytes = output.reduce((s, [, b]) => s + b.length, 0);
  print(`<span class="ok">done in ${buildSeconds.toFixed(1)}s</span> <span class="faint">· ${esc(app.framework.outDir)} ${output.length} files · ${mib(bytes)} · build id ${esc(buildId)}</span>`);
  actions([["deploy", deploy, "▲"], [`download ${app.framework.outDir}`, download], again]);
});

// ---------- deploy (temporary, prebuilt) ----------
async function deploy() {
  running("deploy");
  actions([]);
  let live = null;
  const out = { line: (text) => { live = null; say(text, "faint"); }, progress: (text) => { (live ||= print("", "faint")).textContent = text; } };
  try {
    const proof = { builtInBrowser: true, buildId, buildSeconds: Number(buildSeconds.toFixed(1)), builtAt: new Date().toISOString(), command: `${app.framework.name} ${app.framework.args.join(" ")}`, buildPage: location.origin, userAgent: navigator.userAgent };
    const result = await deployPrebuilt(toBuildOutput(app.framework, output, app.files, proof), out);
    const minutes = Math.max(0, Math.round((result.expiresAt - Date.now()) / 60000));
    print(`<span class="faint">proof</span> <a href="${result.url}/built-in-browser.json" target="_blank" rel="noopener">/built-in-browser.json</a> <span class="faint">→ build id ${esc(buildId)}</span>`);
    print(`<span class="faint">expires in ${minutes} min ·</span> <a href="${result.claimUrl}" target="_blank" rel="noopener">claim it</a> <span class="faint">(private link)</span>`);
    print(`<span class="ok">deployed</span> <a href="${result.url}" target="_blank" rel="noopener">${esc(result.url)}</a>`);
    actions([[`download ${app.framework.outDir}`, download], again]);
    running(null);
  } catch (e) {
    say(`deploy failed: ${e.message || e}`, "bad");
    running(null);
    actions([["deploy", deploy, "▲"], [`download ${app.framework.outDir}`, download], again]);
  }
}

// ---------- download .next as .tar.gz ----------
function tar(files) {
  const enc = new TextEncoder(), parts = [];
  const field = (buf, off, len, value) => buf.set(enc.encode(value).subarray(0, len), off);
  const octal = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  for (const [path, contents, link] of files) {
    const data = link ? new Uint8Array(0) : contents;
    const h = new Uint8Array(512);
    let name = path, prefix = "";
    if (name.length > 100) { const cut = name.lastIndexOf("/", 155); prefix = name.slice(0, cut); name = name.slice(cut + 1); }
    field(h, 0, 100, name); field(h, 100, 8, octal(0o644, 8)); field(h, 108, 8, octal(0, 8)); field(h, 116, 8, octal(0, 8));
    field(h, 124, 12, octal(data.length, 12)); field(h, 136, 12, octal(Math.floor(Date.now() / 1000), 12));
    field(h, 148, 8, "        "); h[156] = link ? 50 : 48; if (link) field(h, 157, 100, link); field(h, 257, 6, "ustar\0"); field(h, 263, 2, "00"); field(h, 345, 155, prefix);
    field(h, 148, 8, octal(h.reduce((s, b) => s + b, 0), 7) + " ");
    parts.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return new Blob(parts);
}
async function download() {
  const gz = await new Response(tar(output).stream().pipeThrough(new CompressionStream("gzip"))).blob();
  Object.assign(document.createElement("a"), { href: URL.createObjectURL(gz), download: `${app.framework.name}-build.tar.gz` }).click();
}

// ---------- inputs ----------
async function sample() {
  const files = await (await fetch("/sample.json")).json();
  build(Object.entries(files).map(([p, s]) => [p, new TextEncoder().encode(s)]), "sample");
}
async function example(name) {
  const res = await fetch(`/examples/${encodeURIComponent(name)}.json`);
  if (!res.ok) return say(`no example named ${name}`, "bad");
  const snap = await res.json();
  history.replaceState(null, "", `?example=${encodeURIComponent(name)}`);
  print(`<span class="faint">source</span> <a href="${esc(snap.source)}" target="_blank" rel="noopener">vercel/next.js/examples/${esc(name)}</a>`);
  build(snap.files.map(([p, enc, data]) => [p, enc === "base64" ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : new TextEncoder().encode(data)]), "example", name);
}
const requested = new URLSearchParams(location.search).get("example");
fetch("/examples/index.json").then((r) => r.json()).then(({ examples }) => {
  const group = document.createElement("optgroup");
  group.label = "Next.js examples";
  for (const ex of examples) group.append(Object.assign(new Option(ex.name, ex.name), { title: ex.description }));
  picker.append(group);
  if (requested) picker.value = requested;
});
if (interrupted) say(`tab reloaded during the ${interrupted}, likely out of memory`, "bad");
else if (requested) example(requested);

$("folder").onchange = async (e) => {
  const files = [];
  for (const f of e.target.files) if (!IGNORE.test(f.webkitRelativePath)) files.push([f.webkitRelativePath, new Uint8Array(await f.arrayBuffer())]);
  build(files, "folder");
};
// The whole page accepts a dropped folder; the terminal card's border shows it.
addEventListener("dragover", (e) => { e.preventDefault(); $("term").classList.add("over"); });
addEventListener("dragleave", (e) => { if (!e.relatedTarget) $("term").classList.remove("over"); });
addEventListener("drop", async (e) => {
  e.preventDefault();
  $("term").classList.remove("over");
  const files = [];
  for (const item of e.dataTransfer.items) { const entry = item.webkitGetAsEntry && item.webkitGetAsEntry(); if (entry) await readEntry(entry, "", files); }
  build(files, "dropped");
});
