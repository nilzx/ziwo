// Stored embeddings, packed, and the copy of them the object searches.
//
// A vector is kept as 8-bit integers: the unit vector times 127, rounded.
// Up to packSize vectors share one row of vector_rows, with the row numbers
// of their memories packed beside them, so that loading every vector reads
// one row per packSize of them. Each row is labelled with the model and the
// size that made its vectors; only the rows of the label in use are loaded
// and searched.
//
// Rows are written through VectorRows alone, which keeps its loaded copy
// (the mirror) equal to the stored rows of its label. A transaction that
// fails after changing the mirror makes the store drop it (see Store.tx).

import { blob, type Db, num, text } from "./db";

// packSize is how many vectors one row holds at most.
export const packSize = 256;

// maxDims bounds the size of a vector, so that a full row stays well under
// the platform's limit of 2 MB a value.
export const maxDims = 4096;

// Label says which model made a vector, and its size.
export interface Label {
  model: string;
  dims: number;
}

// VectorHit is a memory found by meaning: its row number and the similarity
// of its vector to the query's.
export interface VectorHit {
  n: number;
  score: number;
}

// quantise stores a unit vector as 8-bit integers: each component times 127,
// rounded to the nearest integer.
export function quantise(unit: ArrayLike<number>): Int8Array {
  const q = new Int8Array(unit.length);
  for (let i = 0; i < unit.length; i++) {
    const x = Math.round(unit[i]! * 127);
    q[i] = x > 127 ? 127 : x < -127 ? -127 : x;
  }
  return q;
}

// A row of vector_rows as held in memory: room for packSize vectors, of
// which the first count are in use.
interface Pack {
  pack: number; // the row's key
  count: number;
  ns: Int32Array; // packSize row numbers of memories
  vecs: Int8Array; // packSize * dims
}

// A row is well formed when its blobs hold exactly count entries. Rows that
// are not are never loaded, and are dropped with those of other labels.
const wellFormed = `count BETWEEN 1 AND ${packSize} AND length(ns) = 4 * count AND length(vecs) = count * dims`;

function newPack(pack: number, dims: number): Pack {
  return { pack, count: 0, ns: new Int32Array(packSize), vecs: new Int8Array(packSize * dims) };
}

function decodeNs(buf: ArrayBuffer, count: number, into: Int32Array): void {
  const view = new DataView(buf);
  for (let i = 0; i < count; i++) into[i] = view.getInt32(4 * i, true);
}

function encodeNs(p: Pack): ArrayBuffer {
  const buf = new ArrayBuffer(4 * p.count);
  const view = new DataView(buf);
  for (let i = 0; i < p.count; i++) view.setInt32(4 * i, p.ns[i]!, true);
  return buf;
}

function encodeVecs(p: Pack, dims: number): ArrayBuffer {
  return p.vecs.slice(0, p.count * dims).buffer;
}

// Mirror is the loaded copy of the rows of one label.
class Mirror {
  readonly packs = new Map<number, Pack>(); // by key, in the order loaded or made
  readonly where = new Map<number, Pack>(); // memory row number -> its pack

  constructor(readonly label: Label) {}

  get size(): number {
    return this.where.size;
  }

  // search returns up to k vectors closest to q, best first, leaving out any
  // whose similarity is below min, and any of a memory not in among when it
  // is given. q is a unit vector of the label's size.
  search(q: Float32Array, k: number, min: number, among?: ReadonlySet<number>): VectorHit[] {
    const dims = this.label.dims;
    if (q.length !== dims || k <= 0) return [];
    const top: VectorHit[] = [];
    for (const p of this.packs.values()) {
      const v = p.vecs;
      for (let i = 0; i < p.count; i++) {
        if (among !== undefined && !among.has(p.ns[i]!)) continue;
        const off = i * dims;
        let s = 0;
        for (let j = 0; j < dims; j++) s += q[j]! * v[off + j]!;
        // No correction of the stored vector's length: rounding moves it
        // by well under 1%.
        const score = s / 127;
        if (score < min || (top.length === k && score <= top[k - 1]!.score)) continue;
        // As Go's vector.Index: among equal scores the one met first stays ahead.
        let at = top.length;
        while (at > 0 && top[at - 1]!.score < score) at--;
        top.splice(at, 0, { n: p.ns[i]!, score });
        if (top.length > k) top.pop();
      }
    }
    return top;
  }
}

// HeldFigure says how many vectors of one label are stored.
export interface HeldFigure {
  model: string;
  dims: number;
  count: number;
}

// VectorRows reads and writes vector_rows for one store.
export class VectorRows {
  private mirror?: Mirror;
  // Set when the mirror was changed: the store drops the mirror if the
  // transaction that changed it fails.
  touched = false;

  constructor(private readonly db: Db) {}

  // forget drops the loaded copy; the next use loads it again.
  forget(): void {
    this.mirror = undefined;
  }

  // loaded reports whether the rows of label are held in memory.
  loaded(label: Label): boolean {
    return this.mirror !== undefined && sameLabel(this.mirror.label, label);
  }

  // index returns the loaded copy of the rows of label, loading it first if
  // needed: one row read per packSize vectors.
  private index(label: Label): Mirror {
    if (this.mirror !== undefined && sameLabel(this.mirror.label, label)) return this.mirror;
    const m = new Mirror({ ...label });
    this.db.each(
      `SELECT pack, count, ns, vecs FROM vector_rows WHERE model = ? AND dims = ? AND ${wellFormed} ORDER BY pack`,
      [label.model, label.dims],
      (r) => {
        const p = newPack(num(r.pack), label.dims);
        p.count = num(r.count);
        decodeNs(blob(r.ns), p.count, p.ns);
        p.vecs.set(new Int8Array(blob(r.vecs)));
        m.packs.set(p.pack, p);
        for (let i = 0; i < p.count; i++) m.where.set(p.ns[i]!, p);
      },
    );
    this.mirror = m;
    return m;
  }

  // load makes sure the rows of label are held in memory.
  load(label: Label): void {
    this.index(label);
  }

  // size reports how many vectors of label are stored.
  size(label: Label): number {
    return this.index(label).size;
  }

  search(label: Label, q: Float32Array, k: number, min: number, among?: ReadonlySet<number>): VectorHit[] {
    return this.index(label).search(q, k, min, among);
  }

  // add stores the unit vectors given, of label, each in place of the one
  // its memory had, else in the first row with room, else in a new row.
  // Each row it changes is written once. The caller holds the transaction.
  add(label: Label, entries: { n: number; vec: ArrayLike<number> }[]): void {
    if (entries.length === 0) return;
    const m = this.index(label);
    const dims = label.dims;
    const changed = new Set<Pack>();
    let open: Pack | undefined;
    for (const e of entries) {
      if (e.vec.length !== dims) throw new Error(`vector of size ${e.vec.length}, the label says ${dims}`);
      if (!Number.isSafeInteger(e.n) || e.n < 1 || e.n > 0x7fffffff) throw new Error(`row number out of range`);
      const q = quantise(e.vec);
      this.touched = true;
      let p = m.where.get(e.n);
      let slot = p === undefined ? -1 : p.ns.subarray(0, p.count).indexOf(e.n);
      if (p === undefined || slot < 0) {
        if (open === undefined || open.count === packSize) {
          open = undefined;
          for (const c of m.packs.values()) {
            if (c.count < packSize) {
              open = c;
              break;
            }
          }
          if (open === undefined) {
            // A key of its own now; its contents are written below.
            const key = num(this.db.first(
              `INSERT INTO vector_rows(model, dims, count, ns, vecs) VALUES(?, ?, 0, x'', x'') RETURNING pack`,
              label.model, dims,
            )?.pack);
            open = newPack(key, dims);
            m.packs.set(key, open);
          }
        }
        p = open;
        slot = p.count++;
        p.ns[slot] = e.n;
        m.where.set(e.n, p);
      }
      p.vecs.set(q, slot * dims);
      changed.add(p);
    }
    for (const p of changed) {
      this.db.run(
        `UPDATE vector_rows SET count = ?, ns = ?, vecs = ? WHERE pack = ?`,
        p.count, encodeNs(p), encodeVecs(p, dims), p.pack,
      );
    }
  }

  // headers reads every row's key, label and row numbers, without its
  // vectors.
  private headers(): { pack: number; model: string; dims: number; count: number; ns: Int32Array }[] {
    const out: { pack: number; model: string; dims: number; count: number; ns: Int32Array }[] = [];
    this.db.each(`SELECT pack, model, dims, count, ns FROM vector_rows WHERE ${wellFormed} ORDER BY pack`, [], (r) => {
      const count = num(r.count);
      const ns = new Int32Array(count);
      decodeNs(blob(r.ns), count, ns);
      out.push({ pack: num(r.pack), model: text(r.model), dims: num(r.dims), count, ns });
    });
    return out;
  }

  // storedNs returns the row number of every stored vector, of any label,
  // once per vector.
  storedNs(): number[] {
    return this.headers().flatMap((h) => [...h.ns]);
  }

  // held reports how many vectors are stored under each label.
  held(): HeldFigure[] {
    return this.db
      .all(`SELECT model, dims, sum(count) AS c FROM vector_rows WHERE ${wellFormed} GROUP BY model, dims ORDER BY model, dims`)
      .map((r) => ({ model: text(r.model), dims: num(r.dims), count: num(r.c) }));
  }

  // storedFor returns the row numbers of the stored vectors of label without
  // loading the vectors themselves.
  storedFor(label: Label): Set<number> {
    if (this.mirror !== undefined && sameLabel(this.mirror.label, label)) return new Set(this.mirror.where.keys());
    const out = new Set<number>();
    for (const h of this.headers()) if (h.model === label.model && h.dims === label.dims) for (const n of h.ns) out.add(n);
    return out;
  }

  // remove deletes the vectors of the given memories under every label and
  // returns how many it deleted. Only the rows that held one are rewritten;
  // a row left empty is deleted. The caller holds the transaction.
  remove(ns: Iterable<number>): number {
    const gone = new Set(ns);
    if (gone.size === 0) return 0;
    let removed = 0;
    for (const h of this.headers()) {
      if (!h.ns.some((n) => gone.has(n))) continue;
      const label = { model: h.model, dims: h.dims };
      const m = this.loaded(label) ? this.mirror : undefined;
      let p = m?.packs.get(h.pack);
      if (p === undefined) {
        p = newPack(h.pack, h.dims);
        p.count = h.count;
        p.ns.set(h.ns);
        p.vecs.set(new Int8Array(blob(this.db.first(`SELECT vecs FROM vector_rows WHERE pack = ?`, h.pack)?.vecs)));
      } else {
        this.touched = true;
      }
      for (let i = p.count - 1; i >= 0; i--) {
        const n = p.ns[i]!;
        if (!gone.has(n)) continue;
        // Fill the hole with the last vector, so the row stays dense.
        const last = p.count - 1;
        if (i !== last) {
          p.ns[i] = p.ns[last]!;
          p.vecs.copyWithin(i * h.dims, last * h.dims, (last + 1) * h.dims);
        }
        p.count--;
        removed++;
        if (m !== undefined && m.where.get(n) === p) m.where.delete(n);
      }
      if (p.count === 0) {
        this.db.run(`DELETE FROM vector_rows WHERE pack = ?`, p.pack);
        m?.packs.delete(p.pack);
      } else {
        this.db.run(`UPDATE vector_rows SET count = ?, ns = ?, vecs = ? WHERE pack = ?`, p.count, encodeNs(p), encodeVecs(p, h.dims), p.pack);
      }
    }
    return removed;
  }

  // dropOthers deletes the rows of every other label, and rows that are not
  // well formed, and returns how many rows it deleted. The caller holds the
  // transaction.
  dropOthers(label: Label): number {
    return this.db.all(
      `DELETE FROM vector_rows WHERE model <> ? OR dims <> ? OR NOT (${wellFormed}) RETURNING pack`,
      label.model, label.dims,
    ).length;
  }

  // removeOrphans deletes the vectors whose memory does not exist.
  removeOrphans(): number {
    const stored = this.storedNs();
    if (stored.length === 0) return 0;
    const orphans = this.db
      .all(`SELECT value AS n FROM json_each(?) WHERE value NOT IN (SELECT n FROM memories)`, JSON.stringify(stored))
      .map((r) => num(r.n));
    return this.remove(orphans);
  }
}

function sameLabel(a: Label, b: Label): boolean {
  return a.model === b.model && a.dims === b.dims;
}
