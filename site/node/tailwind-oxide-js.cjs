// Stand-in for @tailwindcss/oxide (Tailwind's Rust scanner, whose wasm build needs real threads) with the part of
// its API @tailwindcss/postcss uses. It finds candidate class names with a broad token regex; Tailwind keeps only
// the tokens that are real utilities, so extra candidates cost a little time and nothing else.
const fs = require("fs");
const path = require("path");

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".vercel", ".turbo", "out", "dist", "build", "coverage"]);
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$|\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|pdf|zip|gz|tgz|wasm|map)$/i;
const MAX_BYTES = 1 << 20;

function globToRegExp(glob) {
  const esc = (c) => (/[.+^$()|[\]\\]/.test(c) ? "\\" + c : c);
  let re = "", i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) { re += "(?:.*/)?"; i += 3; continue; }
    if (glob.startsWith("**", i)) { re += ".*"; i += 2; continue; }
    const c = glob[i];
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { const end = glob.indexOf("}", i); re += "(?:" + glob.slice(i + 1, end).split(",").map((x) => [...x].map(esc).join("")).join("|") + ")"; i = end; }
    else re += esc(c);
    i++;
  }
  return new RegExp("^" + re + "$");
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(p, out); }
    else if (e.isFile() && !SKIP_FILES.test(p)) out.push(p);
  }
}

function candidates(content, into) {
  for (const raw of content.match(/[^<>"'`\s{}]+/g) || []) {
    const token = raw.replace(/^[(\[,;]+|[),;.]+$/g, "");
    if (token && token.length < 200 && /[a-z]/.test(token)) into.add(token);
  }
}

class Scanner {
  constructor(opts = {}) {
    this._sources = (opts.sources || []).map((s) => ({ base: s.base, pattern: s.pattern || "**/*", negated: !!s.negated }));
    this._files = [];
  }
  scan() {
    const include = this._sources.filter((s) => !s.negated), exclude = this._sources.filter((s) => s.negated);
    const files = new Set();
    for (const src of include) {
      const all = [];
      walk(src.base, all);
      const re = globToRegExp(src.pattern);
      for (const f of all) if (re.test(path.relative(src.base, f))) files.add(f);
    }
    for (const src of exclude) { const re = globToRegExp(src.pattern); for (const f of [...files]) if (re.test(path.relative(src.base, f))) files.delete(f); }
    this._files = [...files];
    const out = new Set();
    for (const f of this._files) {
      try { if (fs.statSync(f).size <= MAX_BYTES) candidates(fs.readFileSync(f, "utf8"), out); } catch {}
    }
    return [...out];
  }
  scanFiles(changed) {
    const out = new Set();
    for (const c of changed || []) candidates(c.content != null ? c.content : fs.readFileSync(c.file, "utf8"), out);
    return [...out];
  }
  getCandidatesWithPositions(changed) {
    const content = changed.content != null ? changed.content : fs.readFileSync(changed.file, "utf8");
    const out = [];
    for (const m of content.matchAll(/[^<>"'`\s{}]+/g)) out.push({ candidate: m[0], position: m.index });
    return out;
  }
  get files() { return this._files; }
  get scannedFiles() { return this._files; }
  get globs() { return this._sources.filter((s) => !s.negated).map(({ base, pattern }) => ({ base, pattern })); }
  get normalizedSources() { return this.globs; }
}

module.exports = { Scanner };
