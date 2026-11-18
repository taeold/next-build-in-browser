// Pieces shared by binding.js and thread-worker.js: the shared memory, WASI over the file system worker, and the
// import object the WASI build of Next.js expects.
import { WASI } from "/wasm-util.js";

const PAGE = 65536;
// 512 MiB initial and 4 GiB maximum, as the binding is linked (--initial-memory in Next.js's .cargo/config.toml).
export const createImportedMemory = () =>
  new WebAssembly.Memory({ initial: 536870912 / PAGE, maximum: 4294967296 / PAGE, shared: true });

export function createWasi(fsClient, data) {
  return new WASI({
    version: "preview1", args: data.args, env: data.env, preopens: data.preopens, fs: fsClient, returnOnExit: true,
    print: (s) => console.log(String(s).trimEnd()), printErr: (s) => console.warn(String(s).trimEnd()),
  });
}

// N-API functions under env, the shared memory, and Turbopack's read_custom_section (its link-time registry lives in
// custom sections of the module).
export function napiEnv(imports, module, memory) {
  imports.env = { ...imports.env, ...imports.napi, ...imports.emnapi, memory, read_custom_section: readCustomSection(module, memory) };
  return imports;
}

function readCustomSection(module, memory) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return (namePtr, nameLength, targetPtr, targetLength) => {
    const name = decoder.decode(new Uint8Array(memory.buffer, namePtr, nameLength).slice());
    const sections = WebAssembly.Module.customSections(module, name);
    if (sections.length === 0) return 0;
    if (sections.length !== 1) throw new Error(`custom section ${JSON.stringify(name)} is ambiguous`);
    const section = new Uint8Array(sections[0]);
    if (targetLength < section.byteLength) return section.byteLength;
    new Uint8Array(memory.buffer, targetPtr, section.byteLength).set(section);
    return section.byteLength;
  };
}
