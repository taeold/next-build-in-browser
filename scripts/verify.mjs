// Builds apps through the page in headless Chromium and prints one line per app.
// Usage: node scripts/verify.mjs [URL] [--deploy] [app ...]
// An app is a folder path, "sample", or "example:<name>" from the page's gallery (opened as ?example=<name>).
// With no apps, runs the sample, the fixtures and every gallery example.
// Needs Playwright with Chromium (PLAYWRIGHT_MODULE and CHROMIUM_PATH can point at an existing install).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const args = process.argv.slice(2);
const url = args[0] && /^https?:/.test(args[0]) ? args.shift() : "http://127.0.0.1:8721/";
const deploy = args.includes("--deploy");
const root = path.resolve(new URL("..", import.meta.url).pathname);
const apps = args.filter((a) => a !== "--deploy");
if (!apps.length) {
  const gallery = JSON.parse(fs.readFileSync(path.join(root, "site/examples/index.json"), "utf8"));
  apps.push("sample", path.join(root, "fixtures/tailwind"), path.join(root, "fixtures/npm-deps"), path.join(root, "fixtures/vite-react"), ...gallery.examples.map((e) => `example:${e.name}`));
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failures = 0;
for (const app of apps) {
  const page = await browser.newPage();
  const text = () => page.innerText("#screen");
  let line;
  try {
    const example = app.startsWith("example:") && app.slice(8);
    const target = new URL(url);
    if (example) target.searchParams.set("example", example);
    await page.goto(target.href);
    await page.waitForFunction(() => /toolchain: ready/.test(document.getElementById("screen").innerText), null, { timeout: 180000 });
    if (app === "sample") await page.getByRole("button", { name: /^(→\s*)?build$/ }).click();
    else if (!example) await page.setInputFiles("#folder", path.resolve(app));
    await page.waitForFunction(() => /done in|build failed|install failed/.test(document.getElementById("screen").innerText), null, { timeout: 600000 });
    const out = await text();
    const install = (out.match(/added \d+ packages[^\n]*/) || [""])[0];
    const done = (out.match(/done in [\d.]+s/) || [""])[0];
    line = done ? `ok    ${done}  ${install}` : `FAIL  ${(out.match(/(Error|failed)[^\n]*/) || ["?"])[0].slice(0, 120)}`;
    if (done && deploy) {
      await page.getByRole("button", { name: /^([→▲]\s*)?deploy$/ }).click();
      await page.waitForFunction(() => /deployed|deploy failed/.test(document.getElementById("screen").innerText), null, { timeout: 600000 });
      const deployed = (await text()).match(/deployed (https:\/\/\S+)/);
      line += deployed ? `  ${deployed[1]}` : "  deploy FAILED";
      if (!deployed) failures++;
    }
    if (!done) failures++;
  } catch (e) {
    line = `FAIL  ${e.message.split("\n")[0]}`;
    failures++;
  }
  console.log(`${line.padEnd(80)}  ${app.replace(root + "/", "")}`);
  await page.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
