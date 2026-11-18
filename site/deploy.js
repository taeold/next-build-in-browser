// Deploys a build made in this tab to Vercel as a prebuilt deployment: Vercel serves the uploaded output and runs
// no build of its own. Uses the same calls as `vercel deploy --prebuilt --temporary`: an anonymous project (no
// account; it expires unless claimed), content-addressed file uploads, then the deployment.
const API = "https://api.vercel.com";

const HANDLER = `process.env.NODE_ENV = "production";
process.chdir(__dirname);
const conf = require("./.next/required-server-files.json").config;
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(conf);
const app = require("next")({ dir: __dirname, dev: false, conf });
const ready = app.prepare();
const handle = app.getRequestHandler();
module.exports = async (req, res) => { await ready; return handle(req, res); };
`;

// Build Output API v3: the standalone server as one Node function, .next/static and public/ as static files.
export function toBuildOutput(dotNext, appFiles, proof) {
  // Values are [bytes, mode]; a symlink is uploaded as its target path with the symlink mode, like the Vercel CLI.
  const enc = new TextEncoder(), out = new Map();
  const FILE = 0o100644, LINK = 0o120777;
  for (const [p, bytes, link] of dotNext) {
    const entry = [bytes, link ? LINK : FILE];
    if (p.startsWith(".next/standalone/")) {
      const rel = p.slice(".next/standalone/".length);
      if (rel !== "server.js") out.set("functions/index.func/" + rel, entry);
    } else if (p.startsWith(".next/static/")) out.set("static/_next/static/" + p.slice(".next/static/".length), entry);
  }
  if (!out.has("functions/index.func/.next/required-server-files.json")) throw new Error("The build has no standalone output to deploy.");
  for (const [p, bytes] of appFiles) if (p.startsWith("public/")) out.set("static/" + p.slice("public/".length), [bytes, FILE]);
  out.set("functions/index.func/handler.js", [enc.encode(HANDLER), FILE]);
  out.set("functions/index.func/.vc-config.json", [enc.encode(JSON.stringify({ runtime: "nodejs22.x", handler: "handler.js", launcherType: "Nodejs", shouldAddHelpers: false })), FILE]);
  out.set("static/built-in-browser.json", [enc.encode(JSON.stringify(proof, null, 2)), FILE]);
  const conf = JSON.parse(new TextDecoder().decode(out.get("functions/index.func/.next/required-server-files.json")[0])).config;
  const images = imagesConfig(conf.images);
  out.set("config.json", [enc.encode(JSON.stringify({ version: 3, ...(images && { images }), routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/index" }] })), FILE]);
  return out;
}

// next/image's optimizer fetches the original from its own server, but on Vercel static files live outside the
// function. Declaring images hands /_next/image to Vercel's optimizer instead, as Vercel's Next.js builder does.
function imagesConfig(images) {
  if (!images || images.unoptimized || images.loader !== "default") return undefined;
  const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined));
  return {
    sizes: [...images.deviceSizes, ...images.imageSizes],
    domains: images.domains,
    remotePatterns: (images.remotePatterns || []).map(compact),
    localPatterns: (images.localPatterns || []).map(compact),
    qualities: images.qualities,
    minimumCacheTTL: images.minimumCacheTTL,
    formats: images.formats,
    dangerouslyAllowSVG: images.dangerouslyAllowSVG,
    contentSecurityPolicy: images.contentSecurityPolicy,
    contentDispositionType: images.contentDispositionType,
  };
}

async function api(path, { token, ...init } = {}) {
  const res = await fetch(API + path, { ...init, headers: { ...(init.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error?.message || `${res.status} ${path}`), { status: res.status, body });
  return body;
}
const sha1 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function deployPrebuilt(output, onProgress) {
  onProgress("creating project");
  const { token, projectId: project, claimUrl, expiresAt } = await api("/v1/anonymous/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

  // Like the Vercel CLI: describe every file by hash, and upload only the ones Vercel says it doesn't have yet.
  // Next.js's server runtime is the same in every deployment, so usually only the app's own files are new.
  const files = await Promise.all([...output].map(async ([path, [bytes, mode]]) => ({ file: ".vercel/output/" + path, sha: await sha1(bytes), size: bytes.length, mode, bytes })));
  const create = () => api("/v13/deployments?skipAutoDetectionConfirmation=1&prebuilt=1", {
    token, method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: project, project, target: "production", version: 2, files: files.map(({ bytes, ...f }) => f), projectSettings: { framework: null, sourceFilesOutsideRootDirectory: true } }),
  });
  onProgress("deploying");
  let dep;
  try {
    dep = await create();
  } catch (e) {
    if (e.body?.error?.code !== "missing_files") throw e;
    const missing = new Set(e.body.error.missing);
    const queue = [...new Map(files.filter((f) => missing.has(f.sha)).map((f) => [f.sha, f])).values()];
    const total = queue.length;
    let done = 0;
    const worker = async () => {
      for (let f; (f = queue.shift()); ) {
        await api("/v2/files", { token, method: "POST", headers: { "Content-Type": "application/octet-stream", "x-vercel-digest": f.sha }, body: f.bytes });
        onProgress(`uploading ${++done}/${total} files`);
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    dep = await create();
  }
  while (!["READY", "ERROR", "CANCELED"].includes(dep.readyState)) {
    onProgress("deploying");
    await new Promise((r) => setTimeout(r, 2000));
    dep = await api(`/v13/deployments/${dep.id}`, { token });
  }
  if (dep.readyState !== "READY") throw new Error(`Deployment ended in state ${dep.readyState}`);
  // Vercel's own log for the deployment, which says it used the uploaded artifacts instead of building.
  let log = [];
  try {
    const events = await api(`/v3/deployments/${dep.id}/events?builds=1&limit=-1`, { token });
    log = (Array.isArray(events) ? events : []).map((e) => (e.payload && e.payload.text) || e.text || "").filter((t) => /deployment files|prebuilt build artifacts|Deploying outputs|Deployment completed/.test(t));
  } catch {}
  // Production aliases (project.vercel.app) are public; the per-deployment URL can sit behind Deployment Protection.
  const alias = (dep.alias || []).find((a) => a.endsWith(".vercel.app") || a.endsWith(".tmp.now")) || dep.alias?.[0];
  return { url: "https://" + (alias || dep.url), deploymentUrl: "https://" + dep.url, inspectorUrl: dep.inspectorUrl, claimUrl, expiresAt, deploymentId: dep.id, log };
}
