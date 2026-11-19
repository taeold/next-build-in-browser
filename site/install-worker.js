// `npm install` for the tab: reads package-lock.json if present, otherwise resolves from the registry, then
// downloads, verifies and unpacks each tarball into /app/node_modules. No install scripts run.
// The plan is a map like package-lock's "packages": location ("node_modules/a/node_modules/b") -> package.
import semver from "/assets/semver.mjs";
import { createFsClient } from "./fs-client.js";

const REGISTRY = "https://registry.npmjs.org/";
const APP = "/app";
// Already in the toolchain archive: next itself, its @next/env, and the swc bindings (the page provides the wasm one).
const PROVIDED = (name) => name === "next" || name === "@next/env" || name.startsWith("@next/swc-");
const PLATFORM = { os: "linux", cpu: "wasm32" };

let fs, say;
self.onmessage = async ({ data }) => {
  if (data.type !== "install") return;
  fs = createFsClient(data.fsPort, data.regPort);
  say = (text) => self.postMessage({ type: "line", text });
  const t0 = performance.now();
  try {
    const pkg = JSON.parse(data.packageJson);
    const plan = data.lockJson ? fromLockfile(JSON.parse(data.lockJson)) : await resolveTree(pkg);
    await addCompanions(plan);
    const result = await install(plan);
    linkBins();
    self.postMessage({ type: "done", ok: true, ...result, seconds: (performance.now() - t0) / 1000, fromLockfile: !!data.lockJson });
  } catch (e) {
    self.postMessage({ type: "done", ok: false, error: String(e && (e.message || e)) });
  }
};

// ---------- platform filter (package.json "os"/"cpu", with "!" negation) ----------
function fits(list, value) {
  if (!list || !list.length) return true;
  const deny = list.filter((x) => x.startsWith("!")).map((x) => x.slice(1));
  const allow = list.filter((x) => !x.startsWith("!"));
  return !deny.includes(value) && (!allow.length || allow.includes(value));
}
const platformOk = (p) => fits(p.os, PLATFORM.os) && fits(p.cpu, PLATFORM.cpu);

// ---------- what the toolchain already has at the top level ----------
function readJson(path) { try { return JSON.parse(new TextDecoder().decode(fs.readFileBytes(path))); } catch { return null; } }
function existingTopLevel() {
  const out = new Map();
  for (const name of topLevel()) { const p = readJson(`${APP}/node_modules/${name}/package.json`); if (p && p.version) out.set(name, p.version); }
  return out;
}

// Package names directly in /app/node_modules ("a", "@scope/b"). None before the first install of a non-Next.js app.
function topLevel() {
  const dir = `${APP}/node_modules`, names = [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return names; }
  for (const n of entries) {
    if (n.startsWith(".")) continue;
    if (n.startsWith("@")) for (const m of fs.readdirSync(`${dir}/${n}`)) names.push(`${n}/${m}`);
    else names.push(n);
  }
  return names;
}

// ---------- lockfile (npm v2/v3) ----------
function fromLockfile(lock) {
  if (!lock.packages) throw new Error("package-lock.json is lockfileVersion 1; only v2 and v3 are supported");
  const plan = new Map();
  for (const [location, p] of Object.entries(lock.packages)) {
    if (!location || p.link || !p.resolved || !location.startsWith("node_modules/")) continue;
    const name = p.name || location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);
    if (PROVIDED(name) || location.startsWith("node_modules/next/")) continue;
    if (!platformOk(p)) continue;
    plan.set(location, { name, version: p.version, tarball: p.resolved, integrity: p.integrity, optional: !!p.optional });
  }
  say(`lockfile: ${plan.size} packages`);
  return plan;
}

// ---------- resolution from the registry ----------
const packuments = new Map();
function packument(name) {
  if (!packuments.has(name)) {
    packuments.set(name, fetch(REGISTRY + name.replace("/", "%2F"), { headers: { Accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" } })
      .then((r) => { if (!r.ok) throw new Error(`npm registry: ${name} -> ${r.status}`); return r.json(); }));
  }
  return packuments.get(name);
}
async function pick(name, range) {
  const doc = await packument(name);
  if (doc["dist-tags"] && doc["dist-tags"][range]) return doc.versions[doc["dist-tags"][range]];
  if (!semver.validRange(range)) throw new Error(`${name}@${range}: only registry versions and tags are supported`);
  const latest = doc["dist-tags"] && doc["dist-tags"].latest;
  const v = latest && semver.satisfies(latest, range) ? latest : semver.maxSatisfying(Object.keys(doc.versions), range);
  if (!v) throw new Error(`no version of ${name} matches ${range}`);
  return doc.versions[v];
}

// `base` is a plan already made: what it installs counts as present.
async function resolveTree(rootPkg, base = new Map()) {
  const plan = new Map();
  const present = existingTopLevel(); // name -> version already in /app/node_modules
  const versionAt = (loc) => (plan.has(loc) ? plan.get(loc).version : base.has(loc) ? base.get(loc).version : loc.split("/").length === 2 ? present.get(loc.slice("node_modules/".length)) : undefined);
  const queue = [];
  const want = (deps, from, kind) => { for (const [name, range] of Object.entries(deps || {})) if (!PROVIDED(name)) queue.push({ name, range, from, kind }); };
  want(rootPkg.dependencies, "", "dep");
  want(rootPkg.devDependencies, "", "dep");
  want(rootPkg.optionalDependencies, "", "optional");

  let resolved = 0;
  while (queue.length) {
    const batch = queue.splice(0, 32);
    await Promise.all(batch.map(async ({ name, range, from, kind }) => {
      // Node's lookup order from the dependent's folder: its own node_modules, then each parent, then the top.
      const chain = [];
      for (let base = from; ; ) {
        chain.push((base ? base + "/" : "") + "node_modules/" + name);
        if (!base) break;
        const i = base.lastIndexOf("/node_modules/");
        base = i < 0 ? "" : base.slice(0, i);
      }
      const hit = chain.find((loc) => versionAt(loc) !== undefined);
      if (hit && (kind === "peer" || semver.satisfies(versionAt(hit), range, { includePrerelease: true }))) return;
      let meta;
      try { meta = await pick(name, range); } catch (e) { if (kind === "optional") return; throw e; }
      if (!platformOk(meta)) { if (kind === "optional") return; throw new Error(`${name}@${meta.version} does not support ${PLATFORM.os}/${PLATFORM.cpu}`); }
      const top = "node_modules/" + name;
      const location = versionAt(top) === undefined && !plan.has(top) ? top : (from ? from + "/" : "") + "node_modules/" + name;
      if (plan.has(location)) return;
      plan.set(location, { name, version: meta.version, tarball: meta.dist.tarball, integrity: meta.dist.integrity, optional: kind === "optional" });
      resolved++;
      // npm publishes optionalDependencies into dependencies as well; the optional entry wins.
      const optional = meta.optionalDependencies || {};
      want(Object.fromEntries(Object.entries(meta.dependencies || {}).filter(([n]) => !(n in optional))), location, "dep");
      want(optional, location, "optional");
      const peerMeta = meta.peerDependenciesMeta || {};
      want(Object.fromEntries(Object.entries(meta.peerDependencies || {}).filter(([n]) => !(peerMeta[n] && peerMeta[n].optional))), "", "peer");
    }));
    self.postMessage({ type: "progress", text: `resolving: ${resolved} packages` });
  }
  return plan;
}

// Packages installed next to another: a native package's official wasm build, at the same version (the runtime
// redirects to it), and the adapter SvelteKit's adapter-auto would install with npm at build time for the host it
// detects (Vercel: builds run with VERCEL=1).
const COMPANIONS = {
  lightningcss: (version) => ["lightningcss-wasm", version],
  rollup: (version) => ["@rollup/wasm-node", version],
  "@sveltejs/adapter-auto": () => ["@sveltejs/adapter-vercel", "*"],
};
async function addCompanions(plan) {
  const extra = {};
  for (const p of plan.values()) {
    const companion = COMPANIONS[p.name] && COMPANIONS[p.name](p.version);
    if (companion && !plan.has("node_modules/" + companion[0])) extra[companion[0]] = companion[1];
  }
  if (!Object.keys(extra).length) return;
  for (const [location, p] of await resolveTree({ dependencies: extra }, plan)) if (!plan.has(location)) plan.set(location, p);
}

// ---------- download, verify, unpack ----------
async function verify(bytes, integrity, name) {
  if (!integrity) return;
  const [algo, expected] = integrity.split(" ")[0].split(/-(.*)/s);
  const subtleAlgo = { sha512: "SHA-512", sha384: "SHA-384", sha256: "SHA-256", sha1: "SHA-1" }[algo];
  if (!subtleAlgo) return;
  const got = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest(subtleAlgo, bytes))));
  if (got !== expected) throw new Error(`integrity check failed for ${name}`);
}
function untar(tar, onFile) {
  const dec = new TextDecoder();
  const str = (o, n) => { const s = tar.subarray(o, o + n); const z = s.indexOf(0); return dec.decode(z < 0 ? s : s.subarray(0, z)); };
  let off = 0, longName = null, paxPath = null;
  while (off + 512 <= tar.length) {
    if (tar[off] === 0) break;
    const name = str(off, 100), size = parseInt(str(off + 124, 12).trim() || "0", 8), type = String.fromCharCode(tar[off + 156] || 48), prefix = str(off + 345, 155);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = dec.decode(body).replace(/\0.*$/s, ""); continue; }
    if (type === "x") { const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(body)); paxPath = m ? m[1] : null; continue; }
    const path = paxPath || longName || (prefix ? prefix + "/" + name : name);
    longName = paxPath = null;
    if (type === "0" || type === "\0" || type === "7") onFile(path, body);
  }
}
function rmrf(path) {
  let st;
  try { st = fs.lstatSync(path); } catch { return; }
  if (st.isDirectory()) { for (const n of fs.readdirSync(path)) rmrf(path + "/" + n); fs.rmdirSync(path); } else fs.unlinkSync(path);
}

async function install(plan) {
  // Keep the toolchain's copy of a package next itself depends on when the app needs a different version.
  const nextPkg = readJson(`${APP}/node_modules/next/package.json`) || {};
  const nextDeps = Object.keys(nextPkg.dependencies || {});
  for (const name of nextDeps) {
    if (!plan.has("node_modules/" + name) || PROVIDED(name)) continue;
    const from = `${APP}/node_modules/${name}`, to = `${APP}/node_modules/next/node_modules/${name}`;
    try { fs.statSync(from); } catch { continue; }
    try { fs.statSync(to); } catch { mkdirp(to.slice(0, to.lastIndexOf("/"))); fs.renameSync(from, to); }
  }
  const items = [...plan.entries()].sort((a, b) => a[0].split("/").length - b[0].split("/").length);
  let done = 0, bytes = 0, skipped = 0;
  const queue = items.slice();
  const worker = async () => {
    for (let item; (item = queue.shift()); ) {
      const [location, p] = item;
      let tgz;
      try {
        const res = await fetch(p.tarball);
        if (!res.ok) throw new Error(`${p.name}: download ${res.status}`);
        tgz = new Uint8Array(await res.arrayBuffer());
        await verify(tgz, p.integrity, p.name);
      } catch (e) {
        if (p.optional) { skipped++; continue; }
        throw e;
      }
      bytes += tgz.length;
      const tar = new Uint8Array(await new Response(new Blob([tgz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
      const dir = `${APP}/${location}`;
      rmrf(dir);
      untar(tar, (path, body) => {
        const rel = path.slice(path.indexOf("/") + 1); // tarballs nest everything under one top folder, usually "package/"
        if (!rel || rel.endsWith("/")) return;
        fs.writeFileBytes(`${dir}/${rel}`, body.slice());
      });
      self.postMessage({ type: "progress", text: `installing: ${++done}/${items.length} packages` });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { added: done, skipped, megabytes: bytes / 1048576 };
}
// node_modules/.bin/<name> links to each top-level package's "bin" entries, as npm makes them.
function linkBins() {
  const dir = `${APP}/node_modules`;
  mkdirp(`${dir}/.bin`);
  for (const name of topLevel()) {
    const pkg = readJson(`${dir}/${name}/package.json`);
    if (!pkg || !pkg.bin) continue;
    const bins = typeof pkg.bin === "string" ? { [pkg.name.split("/").pop()]: pkg.bin } : pkg.bin;
    for (const [bin, target] of Object.entries(bins)) {
      const link = `${dir}/.bin/${bin}`;
      try { fs.unlinkSync(link); } catch {}
      fs.symlinkSync(`../${name}/${target.replace(/^\.\//, "")}`, link);
    }
  }
}
function mkdirp(dir) {
  let cur = "";
  for (const part of dir.split("/").filter(Boolean)) { cur += "/" + part; try { fs.mkdirSync(cur); } catch {} }
}
