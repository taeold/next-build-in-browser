# next build in the browser

Runs `next build` in a browser tab and deploys the output to Vercel. No build server. Vite apps build too.

https://next-build-in-browser.web.app

## How

Turbopack and SWC run as WebAssembly, from the Next.js team's draft `next build --wasi` PRs ([#98987](https://github.com/vercel/next.js/pull/98987), [#98988](https://github.com/vercel/next.js/pull/98988)), consolidated with a few fixes on [my fork](https://github.com/taeold/next.js/tree/next-build-in-browser). The rest of Next.js runs on a small Node.js layer in a web worker. Packages install straight from npm. The finished build can be deployed to Vercel as a prebuilt deployment.

A build takes 14–20 s in headless Chrome on a 2-vCPU VM.

## Limits

- Compile mode only. Nothing is prerendered, so no static export (`output: "export"`).
- No install scripts or native packages.
- Chrome only. Phones may run out of memory.

## License

MIT. Bundled packages keep their own licenses.
