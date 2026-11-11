// Embedding what is written, in the background: what Go's embedLoop and
// embedBatch do, one batch per alarm of the memory's object. Nothing here
// runs on the path of a call: the call that wrote a memory only sets the
// alarm.
//
// A run is ordinary or full. An ordinary run reads only the memories written
// after the mark it keeps in meta (the highest row number it has dealt
// with), so after a write it costs a few rows whatever the memory's size. A
// full run first does what Go's sweep and its search for what waits do over
// every memory: it drops the vectors of memories that no longer need one,
// and moves the mark back to the oldest memory that needs one and has none.
// It runs when a call asked for it, when the label changed, when no run has
// kept a mark yet, and otherwise once fullEvery while alarms run.

import { type Embedder, type EmbedSettings, labelOf, prepare } from "../embed";
import { logLine } from "../log";
import { labelKey, type Store } from "../store/store";
import type { Label } from "../store/vectors";
import { clip } from "./clean";

// embedBatchSize is how many memories one alarm embeds: the most texts the
// model takes in one call. Go's is 16.
export const embedBatchSize = 32;

// embedMaxRunes cuts the text sent for a memory, as Go's EmbedMaxRunes.
export const embedMaxRunes = 1500;

// The delay before trying again after a failure doubles from firstRetry up
// to lastRetry, as Go's embedLoop does, and starts over after a success.
export const firstRetry = 1000;
export const lastRetry = 60_000;

// fullEvery is how often a full run comes without being asked: Go's hourly
// sweep, which drops the vectors of what was archived since.
export const fullEvery = 60 * 60 * 1000;

// textOf is what is embedded of a memory: its gist and body, cut as Go cuts
// them.
export function textOf(m: { gist: string; body: string }): string {
  return clip(m.gist + "\n" + m.body, embedMaxRunes);
}

// EmbedRun is what one run did.
export interface EmbedRun {
  dropped: number; // vectors dropped by the sweep
  embedded: number; // vectors stored
  refused: number; // memories set aside this run
  failed: boolean; // the model could not be used; retryIn says when to try again
  retryIn: number;
  more: boolean; // memories still wait, not counting those set aside
  full: boolean; // the run was a full one
}

// Embedding is the search by meaning of one memory object: its settings,
// its embedder, the memories the model refuses and the delay before the
// next try. The last two live as long as the object's instance, as Go's
// live as long as its process.
export class Embedding {
  private readonly skip = new Set<number>(); // row numbers the model refuses
  private delay = firstRetry;

  constructor(
    readonly settings: EmbedSettings,
    readonly embedder: Embedder,
  ) {}

  get label(): Label {
    return labelOf(this.settings);
  }

  // setAside reports how many memories the model refused.
  get setAside(): number {
    return this.skip.size;
  }

  // failure returns the delay before the next try and doubles it.
  failure(): number {
    const d = this.delay;
    this.delay = Math.min(2 * this.delay, lastRetry);
    return d;
  }

  private async embed(texts: string[]): Promise<Float32Array[]> {
    const raw = await this.embedder.documents(texts);
    if (raw.length !== texts.length) throw new Error("the embedder returned the wrong number of vectors");
    return raw.map((v) => prepare(v, this.settings.dims));
  }

  // run embeds one batch: up to embedBatchSize memories that need a vector,
  // oldest first, leaving out those set aside. now is the wall clock; full
  // makes it a full run whatever is kept in meta.
  async run(st: Store, now: number, full = false): Promise<EmbedRun> {
    const label = this.label;
    const kept = st.vectorRuns();
    full ||= kept.fullAsked || kept.seen === undefined || kept.fullAt === undefined ||
      kept.label !== labelKey(label) || now - kept.fullAt >= fullEvery;
    const dropped = full ? st.fullVectorRun(label, now).dropped : 0;
    const next = st.nextForVectors(label, embedBatchSize, this.skip);
    const byN = st.byN(next.batch);
    const batch = next.batch.flatMap((n) => {
      const m = byN.get(n);
      return m === undefined ? [] : [m];
    });
    const out: EmbedRun = { dropped, embedded: 0, refused: 0, failed: false, retryIn: 0, more: false, full };
    if (batch.length === 0) {
      if (next.seen !== next.from) st.setVectorsSeen(next.seen);
      this.delay = firstRetry;
      return out;
    }
    const texts = batch.map(textOf);
    let vecs: Float32Array[] | undefined;
    let failure: unknown;
    try {
      vecs = await this.embed(texts);
    } catch (err) {
      failure = err;
    }
    // Storing is not the model's failure: an error there goes to the alarm.
    if (vecs !== undefined) {
      out.embedded = st.saveVectors(label, batch.map((m, i) => ({ n: m.n, vec: vecs[i]! })));
    } else {
      const err = failure;
      if (batch.length === 1) return this.failed(out, err);
      // The batch failed. Try each text alone: if some go through, the ones
      // that do not are refused for what they contain, and waiting will not
      // change that, so they are set aside rather than blocking the rest.
      const refused: number[] = [];
      let done = 0;
      for (let i = 0; i < batch.length; i++) {
        let vec: Float32Array;
        try {
          vec = (await this.embed([texts[i]!]))[0]!;
        } catch {
          refused.push(batch[i]!.n);
          continue;
        }
        out.embedded += st.saveVectors(label, [{ n: batch[i]!.n, vec }]);
        done++;
      }
      if (done === 0) return this.failed(out, err); // nothing works: the model is down, not the texts
      for (const n of refused) this.skip.add(n);
      out.refused = refused.length;
      if (refused.length > 0) logLine({ msg: "embedding refused", memories: refused.length });
    }
    if (next.seen !== next.from) st.setVectorsSeen(next.seen);
    this.delay = firstRetry;
    out.more = next.more;
    return out;
  }

  private failed(out: EmbedRun, err: unknown): EmbedRun {
    out.failed = true;
    out.more = true;
    out.retryIn = this.failure();
    logLine({ msg: "embedding failed", error: err instanceof Error ? err.name : "unknown", retry_ms: out.retryIn });
    return out;
  }
}
