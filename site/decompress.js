// Decodes a fetched asset by extension: .gz with the browser's DecompressionStream, .br with brotli-dec-wasm
// (browsers can't decode brotli in a stream yet, and brotli's large window makes the archive less than half the
// size gzip gets). Brotli decodes in one call once the download is complete: its streaming decoder can panic when a
// network chunk ends exactly where an output block does.
import initBrotli, { decompress } from "/pkg/brotli_dec_wasm.js";

function brotli() {
  const chunks = [];
  return new TransformStream({
    transform(chunk) { chunks.push(chunk); },
    async flush(controller) {
      await initBrotli();
      const input = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) { input.set(c, at); at += c.length; }
      controller.enqueue(decompress(input));
    },
  });
}

export function decompressed(body, url) {
  if (url.endsWith(".br")) return body.pipeThrough(brotli());
  if (url.endsWith(".gz")) return body.pipeThrough(new DecompressionStream("gzip"));
  return body;
}
