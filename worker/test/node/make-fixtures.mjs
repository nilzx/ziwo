// Writes the files in fixtures/: fixed strings sealed by the Go build, which
// seal.node.mjs opens. Run it again only if the format changes:
//   node test/node/make-fixtures.mjs

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtures } from "./fixtures.mjs";
import { buildSealHelper, goSeal, removeScratch, scratch } from "./go.mjs";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const tmp = await scratch("ziwo-fixtures-");
try {
  const bin = await buildSealHelper(tmp);
  for (const f of fixtures) {
    const r = goSeal(bin, "seal", new TextEncoder().encode(f.plain), f.pass);
    if (!r.ok) throw new Error(`${f.file}: ${r.error}`);
    await writeFile(path.join(dir, f.file), r.out);
    console.log(`${f.file}: ${r.out.length} bytes`);
  }
} finally {
  await removeScratch(tmp);
}
