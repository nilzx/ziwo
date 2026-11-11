// Turning text into vectors: the settings of the deployment, the embedder
// that calls Workers AI, and the query's embedding, made in the Worker
// within a time limit. Port of internal/embed with the model on the platform.
//
// What is sent to the model is what a memory says, or the query. None of it
// goes to a log.

import { logLine } from "./log";
import { clip, trimSpace } from "./memory/clean";
import { type Label, maxDims } from "./store/vectors";

export const defaultModel = "@cf/qwen/qwen3-embedding-0.6b";
export const defaultDims = 512;
export const defaultMinSimilarity = 0.45;
// Measured on the platform (2026-11-11): a call takes 0.6 to 1.4 s as a rule
// and now and then more than 2 s; at 2 s one recall in nine went without.
export const defaultQueryTimeoutMs = 3000;

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
}

// What of the Worker's environment the settings are read from.
export interface EmbedEnv {
  AI?: Ai;
  EMBED_MODEL?: string;
  EMBED_DIMS?: string;
  EMBED_MIN_SIMILARITY?: string;
  EMBED_QUERY_TIMEOUT_MS?: string;
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
  for (const x of [dims, min, timeout]) {
    if (typeof x === "string") {
      if (!loggedUnreadable.has(x)) {
        loggedUnreadable.add(x);
        logLine({ msg: "embedding off", setting: x, reason: "unreadable" });
      }
      return undefined;
    }
  }
  return { model, dims: dims as number, minSimilarity: min as number, queryTimeoutMs: timeout as number };
}

// Embedder turns text into vectors, as the model returns them. Documents
// are what memories say; a query is what recall is asked.
export interface Embedder {
  documents(texts: string[]): Promise<ArrayLike<number>[]>;
  query(text: string, signal?: AbortSignal): Promise<ArrayLike<number>>;
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

  async query(text: string, signal?: AbortSignal): Promise<number[]> {
    const inputs = this.qwen() ? { queries: [text], instruction: queryInstruction } : { text: [text] };
    return vectorsOf(await this.ai.run(this.model, inputs, signal === undefined ? undefined : { signal }), 1)[0]!;
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
// with the label it was made under.
export interface QueryVector {
  model: string;
  dims: number;
  values: Float32Array;
}

// queryEmbedding returns what embeds a recall's query in the Worker, or
// undefined when search by meaning is off.
export function queryEmbedding(env: EmbedEnv, embedder?: Embedder): ((query: string) => Promise<QueryVector | undefined>) | undefined {
  const settings = embedSettings(env);
  if (settings === undefined) return undefined;
  const emb = embedder ?? new WorkersAI(env.AI!, settings.model);
  return (query) => embedQuery(emb, settings, query);
}

class QueryTimeout extends Error {
  override name = "QueryTimeout";
}

// embedQuery embeds the query recall will read, within the time limit. On
// failure or when the limit runs out it returns undefined, and recall
// answers from keywords.
export async function embedQuery(emb: Embedder, s: EmbedSettings, query: string): Promise<QueryVector | undefined> {
  const text = clip(trimSpace(query), queryMaxRunes);
  if (text === "") return undefined;
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stop.abort();
      reject(new QueryTimeout());
    }, s.queryTimeoutMs);
  });
  try {
    const raw = await Promise.race([emb.query(text, stop.signal), limit]);
    return { model: s.model, dims: s.dims, values: prepare(raw, s.dims) };
  } catch (err) {
    const timedOut = err instanceof QueryTimeout;
    logLine({
      msg: "query embedding failed", reason: timedOut ? "timeout" : "error",
      ...(timedOut ? { limit_ms: s.queryTimeoutMs } : { error: err instanceof Error ? err.name : "unknown" }),
    });
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
