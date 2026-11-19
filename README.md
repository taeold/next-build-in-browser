# npmrunbuild

Drop and build your app. Maybe.

Runs `npm install` and `npm run build` in a browser tab, then deploys the output to Vercel. No build server. Builds Next.js, Astro, SvelteKit and Vite apps.

https://next-build-in-browser.web.app

## How

Each command of the build script runs on a small Node.js layer in a web worker, with real worker threads. Packages install straight from npm. Native tools run as their official WebAssembly builds: Rolldown, Tailwind's oxide, lightningcss, sharp. Next.js uses Turbopack and SWC from the Next.js team's draft `next build --wasi` PRs ([#98987](https://github.com/vercel/next.js/pull/98987), [#98988](https://github.com/vercel/next.js/pull/98988)), with a few fixes on [my fork](https://github.com/taeold/next.js/tree/next-build-in-browser). The finished build can be deployed to Vercel as a prebuilt deployment.

## Limits

- Next.js builds in compile mode only, so no static export.
- No install scripts, child processes or native packages without a wasm build. Nuxt needs esbuild's child process.
- TypeScript 7 is native, so `tsc` type checks are skipped.
- Chrome only. Phones may run out of memory.

## License

MIT. Bundled packages keep their own licenses.
