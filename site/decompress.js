// Decodes a fetched asset by extension: .gz with the browser's DecompressionStream, .br with brotli-dec-wasm
// (browsers can't decode brotli in a stream yet, and brotli's large window makes the archive less than half the
// size gzip gets).
import initBrotli, { DecompressStream, BrotliStreamResultCode } from "/pkg/brotli_dec_wasm.js";

function brotli() {
  let decoder, last;
  return new TransformStream({
    async start() {
      await initBrotli();
      decoder = new DecompressStream();
    },
    transform(chunk, controller) {
      let offset = 0;
      do {
        const result = decoder.decompress(chunk.subarray(offset), 1 << 20);
        if (result.buf.length) controller.enqueue(result.buf);
        offset += result.input_offset;
        last = result.code;
      } while (last === BrotliStreamResultCode.NeedsMoreOutput);
    },
    flush() {
      if (last !== BrotliStreamResultCode.ResultSuccess) throw new Error("truncated brotli stream");
    },
  });
}

export function decompressed(body, url) {
  if (url.endsWith(".br")) return body.pipeThrough(brotli());
  if (url.endsWith(".gz")) return body.pipeThrough(new DecompressionStream("gzip"));
  return body;
}
