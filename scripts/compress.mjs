// Compresses a buffer for the page by the output's extension: .br (brotli, 16 MiB window) or .gz. Brotli runs at
// quality 11 (about 6 minutes for both assets); BROTLI_QUALITY=5 takes seconds, for local test builds.
// As a script: node scripts/compress.mjs IN OUT
import fs from "node:fs";
import zlib from "node:zlib";

export function compress(buf, out) {
  if (out.endsWith(".gz")) return zlib.gzipSync(buf, { level: 9 });
  const { BROTLI_PARAM_QUALITY, BROTLI_PARAM_LGWIN, BROTLI_PARAM_SIZE_HINT } = zlib.constants;
  return zlib.brotliCompressSync(buf, { params: { [BROTLI_PARAM_QUALITY]: Number(process.env.BROTLI_QUALITY || 11), [BROTLI_PARAM_LGWIN]: 24, [BROTLI_PARAM_SIZE_HINT]: buf.length } });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [input, out] = process.argv.slice(2);
  fs.writeFileSync(out, compress(fs.readFileSync(input), out));
}
