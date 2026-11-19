// Snapshots unmodified vercel/next.js examples at one pinned commit into site/examples/, for the page's gallery.
// Writes site/examples/index.json (the gallery list) and site/examples/<name>.json (the files).
// Usage: node scripts/snapshot-examples.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const COMMIT = "62b2306eaf8a968f79d6faba815398447d41bb29";
const EXAMPLES = [
  ["blog-starter", "App Router blog: Markdown, Tailwind, next/font/google"],
  ["radix-ui", "App Router, Radix UI, Tailwind CSS 3"],
  ["with-framer-motion", "Pages Router, Framer Motion page transitions"],
  ["image-component", "App Router, next/image"],
  ["api-routes-apollo-server-and-client", "Pages Router, GraphQL API route with Apollo"],
  ["with-styled-components", "App Router, styled-components"],
  ["with-sass", "App Router, Sass"],
  ["with-redux", "App Router, Redux Toolkit"],
];

const root = path.resolve(new URL("..", import.meta.url).pathname);
const out = path.join(root, "site/examples");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "next-examples-"));
const git = (...args) => execFileSync("git", ["-C", work, ...args], { stdio: ["ignore", "ignore", "inherit"] });
try {
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/vercel/next.js");
  git("sparse-checkout", "set", "--no-cone", ...EXAMPLES.map(([name]) => `/examples/${name}/`));
  git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", COMMIT);
  git("checkout", "-q", "FETCH_HEAD");

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const index = [];
  for (const [name, description] of EXAMPLES) {
    const dir = path.join(work, "examples", name);
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        const bytes = fs.readFileSync(p);
        const text = bytes.toString("utf8");
        const binary = bytes.includes(0) || !Buffer.from(text, "utf8").equals(bytes);
        files.push([path.relative(dir, p), binary ? "base64" : "utf8", binary ? bytes.toString("base64") : text]);
      }
    };
    walk(dir);
    const source = `https://github.com/vercel/next.js/tree/${COMMIT}/examples/${name}`;
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ name, source, files }));
    index.push({ name, description, source });
    console.log(`${name}: ${files.length} files`);
  }
  fs.writeFileSync(path.join(out, "index.json"), JSON.stringify({ commit: COMMIT, examples: index }, null, 2) + "\n");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
