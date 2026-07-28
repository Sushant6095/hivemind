// Test harness — loads the ACTUAL shipped Deno source, not a copy of it.
//
// Base44 functions are single-file Deno entrypoints: each ends in a
// `Deno.serve(...)` and imports `npm:@base44/sdk`, neither of which node can
// run. Rather than duplicating the logic into the test tree (where it would
// quietly drift from what deploys), we slice the module *above* Deno.serve,
// drop the npm: imports, and let node's built-in TypeScript type-stripping
// (v22.18+) handle the annotations. No transpiler, no native binaries, no
// devDependency — `npm test` works on a clean clone on any platform.
//
// The consequence that matters: if someone edits BM25 or the lease protocol in
// base44/functions/**, these tests break. They are testing production.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TMP = join(HERE, ".generated");
mkdirSync(TMP, { recursive: true });

// Minimal Deno shim. The pure helpers only ever reach for env vars.
export function stubDeno(env = {}) {
  globalThis.Deno = { env: { get: (k) => env[k] }, serve: () => {} };
}
stubDeno();

const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

/** Load the pure top-of-file helpers from a deployed function's entry.ts. */
export async function loadFunction(name, exportNames) {
  const src = readFileSync(join(ROOT, "base44", "functions", name, "entry.ts"), "utf8");
  const cut = src.indexOf("Deno.serve(");
  if (cut < 0) throw new Error(`${name}/entry.ts has no Deno.serve entrypoint`);

  const body = src
    .slice(0, cut)
    .replace(/^\s*import\s.*?;\s*$/gm, "") // npm: specifiers node cannot resolve
    .concat(`\nexport { ${exportNames.join(", ")} };\n`);

  // Keyed by content so an edited function is never served from node's cache.
  const file = join(TMP, `${name}.${hash(body)}.ts`);
  writeFileSync(file, body);
  return await import(pathToFileURL(file).href);
}

/** A fake entity collection backed by an array, shaped like the Base44 SDK. */
export function fakeEntity(rows = []) {
  const store = [...rows];
  let seq = 0;
  return {
    rows: store,
    async filter(where = {}) {
      return store.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    },
    async create(doc) {
      const rec = { id: `id-${++seq}`, created_date: new Date().toISOString(), ...doc };
      store.push(rec);
      return rec;
    },
    async update(id, patch) {
      const r = store.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
      return r;
    },
    async delete(id) {
      const i = store.findIndex((x) => x.id === id);
      if (i >= 0) store.splice(i, 1);
      return true;
    },
    async get(id) {
      return store.find((x) => x.id === id) ?? null;
    },
  };
}

export const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
