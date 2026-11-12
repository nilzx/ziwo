// Turning text into vectors: the settings of the deployment, the embedder
// that calls Workers AI, and the query's embedding, made in the Worker
// within a time limit. Port of internal/embed with the model on the platform.
//
// What is sent to the model is what a memory says, or the query. None of it
// goes to a log.

import { logLine } from "./log";
import { clip, queryParts, trimSpace } from "./memory/clean";
import { type Label, maxDims } from "./store/vectors";

export const defaultModel = "@cf/qwen/qwen3-embedding-0.6b";
export const defaultDims = 512;
export const defaultMinSimilarity = 0.45;
// Measured on the platform (2026-11-11): a call takes 0.6 to 1.4 s as a rule
// and now and then more than 2 s; at 2 s one recall in nine went without.
// With a second call beside a slow first (2026-11-12) two recalls in nine
// still ran out 3 s: when the model is slow, both calls are. A recall that
// waits is better than one that misses what it would have found, so 6 s.
export const defaultQueryTimeoutMs = 6000;
// A query's embedding is asked for a second time, beside the first call,
// when the first has not answered after this long; 0 switches it off. The
// first real client (2026-11-12) saw recalls of 2.0 to 3.3 s spent waiting
// on one call, while most calls answer within a second.
export const defaultQueryHedgeMs = 1000;

// The most texts the model takes in one call (its input schema's limit).
export const maxTextsPerCall = 32;

// queryInstruction tells Qwen3-Embedding what a query is for; its model
// card asks for one written for the task, in English.
export const queryInstruction =
  "Given a short description of an earlier conversation, retrieve the first-person account of what happened in it";

// queryMaxRunes is how much of a query recall reads; the Worker embeds the
// same text.
export const queryMaxRunes = 500;

// EmbedSettings are the deployment's settings for search by meaning.
export interface EmbedSettings {
  model: string;
  dims: number;
  minSimilarity: number;
  queryTimeoutMs: number;
  queryHedgeMs: number;
}

// What of the Worker's environment the settings are read from.
export interface EmbedEnv {
  AI?: Ai;
  EMBED_MODEL?: string;
  EMBED_DIMS?: string;
  EMBED_MIN_SIMILARITY?: string;
  EMBED_QUERY_TIMEOUT_MS?: string;
  EMBED_QUERY_HEDGE_MS?: string;
}

export function labelOf(s: EmbedSettings): Label {
  return { model: s.model, dims: s.dims };
}

// A var may come as a string or, from wrangler's JSON, as a number.
function setting(v: unknown): string | undefined {
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return trimSpace(v) === "" ? undefined : trimSpace(v);
  return undefined;
}

function number(v: unknown, name: string, def: number, ok: (x: number) => boolean): number | string {
  const s = setting(v);
  if (s === undefined) return def;
  const x = Number(s);
  return Number.isFinite(x) && ok(x) ? x : name;
}

// The unreadable settings already logged: each is logged once per isolate,
// not on every request that reads it.
const loggedUnreadable = new Set<string>();

// embedSettings reads the settings, or returns undefined when search by
// meaning is off: there is no AI binding, EMBED_MODEL is set empty, or a
// setting cannot be read (logged by name, without its value).
export function embedSettings(env: EmbedEnv): EmbedSettings | undefined {
  if (env.AI === undefined || env.AI === null) return undefined;
  const raw: unknown = env.EMBED_MODEL;
  const model = raw === undefined ? defaultModel : typeof raw === "string" ? trimSpace(raw) : "";
  if (model === "") return undefined;
  const dims = number(env.EMBED_DIMS, "EMBED_DIMS", defaultDims, (x) => Number.isInteger(x) && x >= 1 && x <= maxDims);
  const min = number(env.EMBED_MIN_SIMILARITY, "EMBED_MIN_SIMILARITY", defaultMinSimilarity, (x) => x >= -1 && x <= 1);
  const timeout = number(env.EMBED_QUERY_TIMEOUT_MS, "EMBED_QUERY_TIMEOUT_MS", defaultQueryTimeoutMs, (x) => Number.isInteger(x) && x >= 1 && x <= 60_000);
  const hedge = number(env.EMBED_QUERY_HEDGE_MS, "EMBED_QUERY_HEDGE_MS", defaultQueryHedgeMs, (x) => Number.isInteger(x) && x >= 0 && x <= 60_000);
  for (const x of [dims, min, timeout, hedge]) {
    if (typeof x === "string") {
      if (!loggedUnreadable.has(x)) {
        loggedUnreadable.add(x);
        logLine({ msg: "embedding off", setting: x, reason: "unreadable" });
      }
      return undefined;
    }
  }
  return {
    model, dims: dims as number, minSimilarity: min as number, queryTimeoutMs: timeout as number, queryHedgeMs: hedge as number,
  };
}

// Embedder turns text into vectors, as the model returns them, one per text
// in the order given. Documents are what memories say; queries are what
// recall is asked: a query, and the things it names when it names several,
// in one call.
export interface Embedder {
  documents(texts: string[]): Promise<ArrayLike<number>[]>;
  queries(texts: string[], signal?: AbortSignal): Promise<ArrayLike<number>[]>;
}

// The part of the AI binding used here. The model is a setting, so its
// input and output are not typed by name.
interface AiRunner {
  run(model: string, inputs: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

// vectorsOf reads the model's answer: { data: number[][] }, one per text.
export function vectorsOf(out: unknown, n: number): number[][] {
  const data = typeof out === "object" && out !== null ? (out as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new EmbedError("the model's answer holds no data");
  if (data.length !== n) throw new EmbedError(`the model returned ${data.length} vectors for ${n} texts`);
  for (const v of data) {
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "number")) {
      throw new EmbedError("the model returned a vector that is not a list of numbers");
    }
  }
  return data as number[][];
}

// EmbedError is a call to the model that did not give usable vectors. Its
// message never quotes a text.
export class EmbedError extends Error {
  override name = "EmbedError";
}

// WorkersAI calls the AI binding. Qwen3-Embedding takes documents and
// queries apart, a query with an instruction; any other model is sent
// plain text on both sides, as bge-m3 takes it.
export class WorkersAI implements Embedder {
  private readonly ai: AiRunner;

  constructor(
    ai: Ai,
    readonly model: string,
  ) {
    this.ai = ai as unknown as AiRunner;
  }

  private qwen(): boolean {
    return this.model.startsWith("@cf/qwen/qwen3-embedding");
  }

  async documents(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += maxTextsPerCall) {
      const chunk = texts.slice(i, i + maxTextsPerCall);
      const inputs = this.qwen() ? { documents: chunk } : { text: chunk };
      out.push(...vectorsOf(await this.ai.run(this.model, inputs), chunk.length));
    }
    return out;
  }

  // Both input forms take a list of up to maxTextsPerCall texts (the
  // model's input schema, 2026-11-12); a query and its parts are at most
  // 1 + MaxQueryParts of them. Qwen takes one instruction for the list.
  async queries(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0 || texts.length > maxTextsPerCall) throw new EmbedError(`${texts.length} queries in one call`);
    const inputs = this.qwen() ? { queries: texts, instruction: queryInstruction } : { text: texts };
    return vectorsOf(await this.ai.run(this.model, inputs, signal === undefined ? undefined : { signal }), texts.length);
  }
}

// prepare cuts v to its first dims components and scales it to unit length.
// The full size is normalised too: a model need not return unit vectors.
export function prepare(v: ArrayLike<number>, dims: number): Float32Array {
  if (v.length < dims) throw new EmbedError(`the model returned ${v.length} dimensions, the setting asks for ${dims}`);
  const out = new Float32Array(dims);
  let sum = 0;
  for (let i = 0; i < dims; i++) {
    const x = v[i]!;
    out[i] = x;
    sum += x * x;
  }
  if (!(sum > 0) || !Number.isFinite(sum)) throw new EmbedError("the model returned a vector with no direction");
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < dims; i++) out[i] = out[i]! * inv;
  return out;
}

// QueryVector is the embedding of a recall's query, handed to the object
// with the label it was made under. parts, when the query names several
// things, holds the embedding of each, in the order queryParts gives them.
export interface QueryVector {
  model: string;
  dims: number;
  values: Float32Array;
  parts?: Float32Array[];
}

// SecondCall says whether a query's second call was made, in fixed words:
// off (the setting is 0), not_needed (none was made: the first answered,
// or the limit ran out, before the delay), after_delay, or after_failure
// (the first failed before the delay ran out).
export type SecondCall = "off" | "not_needed" | "after_delay" | "after_failure";

// QueryEmbedding is a query's vector, if one was made in time, and figures
// for the tool's line in the access log. took is absent when no call was
// made: the query was empty.
export interface QueryEmbedding {
  vector?: QueryVector;
  took?: { ms: number; second: SecondCall; answer: "first" | "second" | "none" };
}

// queryEmbedding returns what embeds a recall's query in the Worker, or
// undefined when search by meaning is off.
export function queryEmbedding(env: EmbedEnv, embedder?: Embedder): ((query: string) => Promise<QueryEmbedding>) | undefined {
  const settings = embedSettings(env);
  if (settings === undefined) return undefined;
  const emb = embedder ?? new WorkersAI(env.AI!, settings.model);
  return (query) => embedQuery(emb, settings, query);
}

// embedQuery embeds the query recall will read, within the time limit, and
// when it names several things each of them too, in the same call. It
// makes one call and, if that has not answered after queryHedgeMs, a second
// beside it; a first call that fails before then starts the second at once.
// Whichever answers first with usable vectors is used and the other is
// aborted; an answer that comes later is dropped. On failure, or when the
// limit runs out, the vector is absent and recall answers from keywords.
export function embedQuery(emb: Embedder, s: EmbedSettings, query: string): Promise<QueryEmbedding> {
  const text = clip(trimSpace(query), queryMaxRunes);
  if (text === "") return Promise.resolve({});
  // Split as recall splits it, so that the object pairs each part with its
  // vector by place.
  const parts = queryParts(text);
  const texts = parts.length >= 2 ? [text, ...parts] : [text];
  const start = Date.now();
  const stop = new AbortController();
  return new Promise<QueryEmbedding>((resolve) => {
    let settled = false;
    let second: SecondCall = s.queryHedgeMs > 0 ? "not_needed" : "off";
    let running = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (answer: "first" | "second" | "none", values?: Float32Array[], failure?: unknown) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      stop.abort(); // the call still running, if any, is not waited for
      if (values === undefined) {
        const timedOut = failure === undefined;
        logLine({
          msg: "query embedding failed", reason: timedOut ? "timeout" : "error",
          ...(timedOut ? { limit_ms: s.queryTimeoutMs } : { error: failure instanceof Error ? failure.name : "unknown" }),
        });
      }
      const took = { ms: Date.now() - start, second, answer };
      if (values === undefined) {
        resolve({ took });
        return;
      }
      const [whole, ...rest] = values;
      const vector: QueryVector = { model: s.model, dims: s.dims, values: whole!, ...(rest.length > 0 ? { parts: rest } : {}) };
      resolve({ vector, took });
    };
    const call = (which: "first" | "second") => {
      running++;
      // A vector the settings cannot use, or an answer that does not hold
      // one vector for each text, counts as that call's failure.
      Promise.resolve()
        .then(() => emb.queries(texts, stop.signal))
        .then((raw) => {
          if (raw.length !== texts.length) throw new EmbedError(`the model returned ${raw.length} vectors for ${texts.length} texts`);
          return raw.map((v) => prepare(v, s.dims));
        })
        .then(
          (values) => finish(which, values),
          (err: unknown) => {
            running--;
            if (settled) return;
            if (which === "first" && second === "not_needed") startSecond("after_failure");
            else if (running === 0) finish("none", undefined, err ?? new EmbedError("the call failed"));
          },
        );
    };
    const startSecond = (why: "after_delay" | "after_failure") => {
      if (settled || second !== "not_needed") return;
      second = why;
      call("second");
    };
    call("first");
    if (s.queryHedgeMs > 0) timers.push(setTimeout(() => startSecond("after_delay"), s.queryHedgeMs));
    timers.push(setTimeout(() => finish("none"), s.queryTimeoutMs));
  });
}
