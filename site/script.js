// `npm run <name>`: the commands a package.json script runs, in order. Handles `a && b`, leading VAR=value
// assignments, cross-env, and other scripts run through npm, pnpm, yarn or bun.
export function commands(scripts, name, env = {}) {
  const script = scripts[name];
  if (script == null) throw new Error(`no "${name}" script in package.json`);
  const out = [];
  for (const part of script.split(/\s*&&\s*/)) {
    const words = split(part), vars = { ...env };
    for (;;) {
      if (words[0] === "cross-env") words.shift();
      else if (/^[A-Za-z_]\w*=/.test(words[0] || "")) { const [k, ...v] = words.shift().split("="); vars[k] = v.join("="); }
      else break;
    }
    if (!words.length) continue;
    const [bin, ...args] = words;
    const sub = /^(npm|pnpm|yarn|bun)$/.test(bin) && (/^run(-script)?$/.test(args[0]) ? args[1] : args[0]);
    if (sub && scripts[sub] != null) out.push(...commands(scripts, sub, vars));
    else out.push({ bin, args, env: vars });
  }
  return out;
}

// Shell words: whitespace-separated, with '...' and "..." quoting.
function split(s) {
  const words = [];
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}
