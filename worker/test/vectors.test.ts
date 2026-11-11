// The packed vectors: what goes in comes out to the precision of 8 bits,
// rows fill to 256 before a new one starts, removing a vector rewrites its
// row alone, and other labels are not searched and are dropped.

import { describe, expect, it } from "vitest";
import { Db } from "../src/store/db";
import { packSize, quantise, VectorRows } from "../src/store/vectors";
import { withStore } from "./helpers";

// rng: mulberry32, so that a failure can be replayed.
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// randomUnit returns a unit vector with components spread over both signs.
export function randomUnit(r: () => number, dims: number): Float32Array {
  const v = new Float32Array(dims);
  let sum = 0;
  for (let i = 0; i < dims; i++) {
    v[i] = r() * 2 - 1;
    sum += v[i]! * v[i]!;
  }
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < dims; i++) v[i] = v[i]! * inv;
  return v;
}

interface StoredRow {
  pack: number;
  model: string;
  dims: number;
  count: number;
  ns: number[];
  vecs: Int8Array;
}

// rowsOf decodes vector_rows on its own, as the layout says: ns little-endian
// int32, vecs one signed byte a component.
function rowsOf(storage: DurableObjectStorage): StoredRow[] {
  return storage.sql
    .exec<{ pack: number; model: string; dims: number; count: number; ns: ArrayBuffer; vecs: ArrayBuffer }>(
      `SELECT pack, model, dims, count, ns, vecs FROM vector_rows ORDER BY pack`,
    )
    .toArray()
    .map((r) => {
      const view = new DataView(r.ns);
      const ns = Array.from({ length: r.ns.byteLength / 4 }, (_, i) => view.getInt32(4 * i, true));
      return { pack: r.pack, model: r.model, dims: r.dims, count: r.count, ns, vecs: new Int8Array(r.vecs) };
    });
}

const x = { model: "model-x", dims: 64 };

describe("packed vectors", () => {
  it("come out as they went in, to the precision of 8 bits", () =>
    withStore((_s, storage) => {
      const r = rng(7);
      const want = new Map<number, Float32Array>();
      for (let n = 1; n <= 300; n++) want.set(n, randomUnit(r, x.dims));
      const rows = new VectorRows(new Db(storage.sql));
      storage.transactionSync(() => rows.add(x, [...want].map(([n, vec]) => ({ n, vec }))));

      // Byte for byte: each component is the unit vector's times 127, rounded.
      const stored = rowsOf(storage);
      let seen = 0;
      for (const row of stored) {
        expect([row.model, row.dims, row.ns.length, row.vecs.length]).toEqual([x.model, x.dims, row.count, row.count * x.dims]);
        row.ns.forEach((n, i) => {
          const v = want.get(n)!;
          const q = row.vecs.subarray(i * x.dims, (i + 1) * x.dims);
          expect([...q]).toEqual([...quantise(v)]);
          for (let j = 0; j < x.dims; j++) expect(Math.abs(q[j]! / 127 - v[j]!)).toBeLessThanOrEqual(0.5 / 127 + 1e-6);
          seen++;
        });
      }
      expect(seen).toBe(300);

      // Loaded afresh, each vector finds itself first, at a similarity of
      // nearly one.
      const again = new VectorRows(new Db(storage.sql));
      expect(again.size(x)).toBe(300);
      for (const [n, v] of want) {
        const hits = again.search(x, v, 1, 0.45);
        expect(hits.map((h) => h.n)).toEqual([n]);
        expect(hits[0]!.score).toBeGreaterThan(0.99);
        expect(hits[0]!.score).toBeLessThan(1.01);
      }
    }));

  it("fill a row to 256 before a new one starts", () =>
    withStore((_s, storage) => {
      const r = rng(8);
      const rows = new VectorRows(new Db(storage.sql));
      const add = (from: number, count: number) =>
        storage.transactionSync(() =>
          rows.add(x, Array.from({ length: count }, (_, i) => ({ n: from + i, vec: randomUnit(r, x.dims) }))),
        );
      const counts = () => rowsOf(storage).map((row) => row.count);
      add(1, 300);
      expect(counts()).toEqual([packSize, 44]);
      add(301, 212);
      expect(counts()).toEqual([packSize, packSize]);
      add(513, 1);
      expect(counts()).toEqual([packSize, packSize, 1]);
      // A vector given again replaces the one stored, in its place.
      const before = rowsOf(storage);
      const v = randomUnit(r, x.dims);
      add(5, 1);
      storage.transactionSync(() => rows.add(x, [{ n: 5, vec: v }]));
      const after = rowsOf(storage);
      expect(after.map((row) => [row.count, row.ns])).toEqual(before.map((row) => [row.count, row.ns]));
      const i = after[0]!.ns.indexOf(5);
      expect([...after[0]!.vecs.subarray(i * x.dims, (i + 1) * x.dims)]).toEqual([...quantise(v)]);
    }));

  it("removing a vector rewrites its row and no other", () =>
    withStore((_s, storage) => {
      const r = rng(9);
      const db = new Db(storage.sql);
      const rows = new VectorRows(db);
      const want = new Map<number, Float32Array>();
      for (let n = 1; n <= 600; n++) want.set(n, randomUnit(r, x.dims));
      storage.transactionSync(() => rows.add(x, [...want].map(([n, vec]) => ({ n, vec }))));
      const before = rowsOf(storage);
      expect(before.map((row) => row.count)).toEqual([256, 256, 88]);

      // Memory 300 is in the second row.
      db.resetUsage();
      expect(storage.transactionSync(() => rows.remove([300]))).toBe(1);
      expect(db.usage().rowsWritten).toBe(1);
      const after = rowsOf(storage);
      expect(after[0]).toEqual(before[0]);
      expect(after[2]).toEqual(before[2]);
      expect(after[1]!.count).toBe(255);
      expect(after[1]!.ns).not.toContain(300);
      // The last vector of the row took its place, whole.
      const moved = before[1]!.ns[255]!;
      const at = after[1]!.ns.indexOf(moved);
      expect([...after[1]!.vecs.subarray(at * x.dims, (at + 1) * x.dims)]).toEqual([...quantise(want.get(moved)!)]);
      // The loaded copy agrees with what is stored.
      expect(rows.search(x, want.get(300)!, 1, 0.9)).toEqual([]);
      expect(rows.search(x, want.get(moved)!, 1, 0.9).map((h) => h.n)).toEqual([moved]);
      expect(new VectorRows(db).size(x)).toBe(599);
      // The next vector fills the first row with room: the hole.
      storage.transactionSync(() => rows.add(x, [{ n: 601, vec: randomUnit(r, x.dims) }]));
      expect(rowsOf(storage).map((row) => row.count)).toEqual([256, 256, 88]);
      storage.transactionSync(() => rows.remove([601]));

      // A row left empty is deleted.
      storage.transactionSync(() => rows.remove(after[2]!.ns));
      expect(rowsOf(storage).map((row) => row.count)).toEqual([256, 255]);
      expect(rows.size(x)).toBe(511);
      // Removing what is not stored changes nothing.
      db.resetUsage();
      expect(storage.transactionSync(() => rows.remove([9999]))).toBe(0);
      expect(db.usage().rowsWritten).toBe(0);
    }));

  it("of another model or size are not searched, and are dropped", () =>
    withStore((_s, storage) => {
      const r = rng(10);
      const rows = new VectorRows(new Db(storage.sql));
      const y = { model: "model-y", dims: 64 };
      const x32 = { model: "model-x", dims: 32 };
      const vx = randomUnit(r, 64);
      storage.transactionSync(() => rows.add(x, [{ n: 1, vec: vx }, { n: 2, vec: randomUnit(r, 64) }]));
      storage.transactionSync(() => rows.add(y, [{ n: 1, vec: vx }]));
      storage.transactionSync(() => rows.add(x32, [{ n: 3, vec: randomUnit(r, 32) }]));
      expect([rows.size(x), rows.size(y), rows.size(x32)]).toEqual([2, 1, 1]);
      // The same vector under another label is not found by a search of x
      // made after y was loaded, and the other way round.
      expect(rows.search(y, vx, 5, 0.45).map((h) => h.n)).toEqual([1]);
      expect(rows.search(x, vx, 5, 0.45).map((h) => h.n)).toEqual([1]);
      expect(rows.search(x32, randomUnit(r, 64), 5, -1)).toEqual([]); // a query of the wrong size matches nothing
      expect(rows.held()).toEqual([
        { model: "model-x", dims: 32, count: 1 },
        { model: "model-x", dims: 64, count: 2 },
        { model: "model-y", dims: 64, count: 1 },
      ]);
      // A row that is not well formed is never loaded, and goes with the others.
      storage.sql.exec(`INSERT INTO vector_rows(model, dims, count, ns, vecs) VALUES('model-x', 64, 2, x'01000000', x'00')`);
      expect(new VectorRows(new Db(storage.sql)).size(x)).toBe(2);
      expect(storage.transactionSync(() => rows.dropOthers(x))).toBe(3);
      expect(rows.held()).toEqual([{ model: "model-x", dims: 64, count: 2 }]);
      expect(rows.storedNs()).toEqual([1, 2]);
    }));
});
