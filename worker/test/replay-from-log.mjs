// Extract a synthetic scale-test failure into a temporary Vitest replay test.
// Usage: node test/replay-from-log.mjs path/to/failed-run.log
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("Pass the captured scale-test log path");
const line = readFileSync(path, "utf8").split(/\r?\n/).find((s) => s.startsWith("REPLAY_FAILURE "));
if (!line) throw new Error("No REPLAY_FAILURE record found");
const fixture = JSON.parse(line.slice("REPLAY_FAILURE ".length));
if (!Array.isArray(fixture.input?.events) || !Array.isArray(fixture.input?.contents)) throw new Error("Invalid replay input");
const source = `// Generated from synthetic scale-test data; remove after diagnosis.
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Memory as MemoryObject } from "../src/memory-object";
import { dump, freshObject, testParams } from "./helpers";
const fixture = ${JSON.stringify(fixture)};
it("replays captured synthetic scale input", async () => {
  const stub = freshObject();
  const actual = await runInDurableObject(stub, (obj: MemoryObject, state) => {
    obj.store.setParams(testParams());
    for (const e of fixture.input.events) state.storage.sql.exec("INSERT INTO events(seq, at, kind, payload) VALUES (?, ?, ?, ?)", e.seq, e.at, e.kind, e.payload);
    for (const c of fixture.input.contents) state.storage.sql.exec("INSERT INTO contents(id, data) VALUES (?, ?)", c.id, c.data);
    obj.store.rebuild();
    const first = dump(obj.store, state.storage);
    obj.store.rebuild();
    return { first, second: dump(obj.store, state.storage) };
  });
  expect(actual.second).toBe(actual.first);
  if (fixture.result?.before !== undefined) expect(actual.first).toBe(fixture.result.before);
}, 120_000);
`;
const output = "test/replay-input.generated.test.ts";
writeFileSync(output, source, { flag: "wx" });
process.stdout.write(`Created ${output}; run ./node_modules/.bin/vitest run ${output}, then remove it.\n`);
