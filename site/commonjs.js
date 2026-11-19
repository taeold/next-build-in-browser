// Compiles modules for node/runtime.js: an ES module to CommonJS, so require() of ESM works as in Node 22+, and in
// any module import.meta and import() as the runtime provides them. SWC's standalone wasm build, pinned, from
// jsDelivr's npm mirror.
const SWC = "https://cdn.jsdelivr.net/npm/@swc/wasm-web@1.16.22/wasm.js";

export async function loadCompiler() {
  const swc = await import(SWC);
  await swc.default();

  // Every import.meta becomes __vv_meta and every import() becomes __vv_import(). SWC's own CommonJS forms differ
  // from Node's (import.meta.resolve as require.resolve, which returns a path, not a URL; import() as a synchronous
  // require), and it leaves the rest of import.meta as a syntax error outside a module. Found by parsing, so methods
  // named import and strings that mention either stay as they are. Span offsets are UTF-8 bytes and count on from
  // SWC's earlier parses: a leading ";" puts the program's own start at offset 0.
  const rewrite = (code, isModule) => {
    if (!(isModule && code.includes("import.meta")) && !/\bimport\s*\(/.test(code)) return code;
    let ast;
    try { ast = swc.parseSync(";" + code, { syntax: "ecmascript", importAttributes: true, target: "es2022", isModule }); }
    catch { return code; }
    const edits = [];
    (function walk(n) {
      if (!n || typeof n !== "object") return;
      if (n.type === "MetaProperty") edits.push([n.span, "__vv_meta"]);
      else if (n.type === "CallExpression" && n.callee && n.callee.type === "Import") edits.push([n.callee.span, "__vv_import"]);
      for (const k in n) if (k !== "span") walk(n[k]);
    })(ast);
    if (!edits.length) return code;
    const bytes = new TextEncoder().encode(";" + code), dec = new TextDecoder(), base = ast.span.start;
    let out = "", at = 0;
    for (const [s, text] of edits.sort((a, b) => a[0].start - b[0].start)) { out += dec.decode(bytes.subarray(at, s.start - base)) + text; at = s.end - base; }
    return (out + dec.decode(bytes.subarray(at))).slice(1);
  };

  // "swc" interop honors __esModule, so a default import of another compiled ES module gets its default export.
  return (source, filename, esm) => (!esm ? rewrite(source, false) : swc.transformSync(rewrite(source, true), {
    filename, isModule: true, sourceMaps: false,
    jsc: { parser: { syntax: "ecmascript", importAttributes: true }, target: "es2022" },
    module: { type: "commonjs", importInterop: "swc" },
  }).code);
}
