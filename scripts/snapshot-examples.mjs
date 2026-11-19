// Snapshots unmodified example apps from each framework's own repository, at pinned commits, into site/examples/,
// for the page's gallery. Writes site/examples/index.json (the gallery list) and site/examples/<id>.json (the files).
// Usage: node scripts/snapshot-examples.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Each source is one repository at one commit; an example is [folder under dir, id on the page, description].
const SOURCES = [
  {
    framework: "Next.js", repo: "vercel/next.js", commit: "62b2306eaf8a968f79d6faba815398447d41bb29", dir: "examples",
    examples: [
      ["blog-starter", "blog-starter", "App Router blog: Markdown, Tailwind, next/font/google"],
      ["image-component", "image-component", "App Router, next/image"],
      ["api-routes-apollo-server-and-client", "api-routes-apollo-server-and-client", "Pages Router, GraphQL API route with Apollo"],
      ["with-redux", "with-redux", "App Router, Redux Toolkit"],
    ],
  },
  {
    framework: "Astro", repo: "withastro/astro", commit: "6fb274ee5026f00df2b140a5acb3d1aacfab68af", dir: "examples",
    examples: [
      ["blog", "astro-blog", "Markdown, MDX, optimized images, sitemap"],
      ["portfolio", "astro-portfolio", "Static portfolio site"],
    ],
  },
  {
    framework: "SvelteKit", repo: "sveltejs/cli", commit: "92b0d37fd24be0544f1dfc066306cd4758daa8c7", dir: "packages/sv/src/create/templates",
    examples: [["demo", "sveltekit-demo", "The sv create demo: Sverdle, server routes"]],
  },
  {
    framework: "Vite", repo: "vitejs/vite", commit: "ef295d54d56478437112acd7deeb9821d755b90f", dir: "packages/create-vite",
    examples: [
      ["template-react-ts", "vite-react", "React + TypeScript"],
      ["template-vue-ts", "vite-vue", "Vue + TypeScript, vue-tsc"],
      ["template-svelte-ts", "vite-svelte", "Svelte + TypeScript"],
    ],
  },
];

const root = path.resolve(new URL("..", import.meta.url).pathname);
const out = path.join(root, "site/examples");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const index = [];
for (const src of SOURCES) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "examples-"));
  const git = (...args) => execFileSync("git", ["-C", work, ...args], { stdio: ["ignore", "ignore", "inherit"] });
  try {
    git("init", "-q");
    git("remote", "add", "origin", `https://github.com/${src.repo}`);
    git("sparse-checkout", "set", "--no-cone", ...src.examples.map(([folder]) => `/${src.dir}/${folder}/`));
    git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", src.commit);
    git("checkout", "-q", "FETCH_HEAD");
    for (const [folder, id, description] of src.examples) {
      const dir = path.join(work, src.dir, folder);
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
      const where = `${src.repo}/${src.dir}/${folder}`;
      const source = `https://github.com/${src.repo}/tree/${src.commit}/${src.dir}/${folder}`;
      fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify({ name: id, where, source, files }));
      index.push({ name: id, framework: src.framework, description, where, source });
      console.log(`${id}: ${files.length} files`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
fs.writeFileSync(path.join(out, "index.json"), JSON.stringify({ examples: index }, null, 2) + "\n");
