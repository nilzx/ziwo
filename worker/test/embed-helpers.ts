// Stand-ins for the embedding model: Go's topicEmbedder, behind the
// Embedder interface, and a fake Workers AI binding that answers as the
// documentation says Qwen3-Embedding does, with the same vectors.

import { type Embedder, type EmbedSettings, prepare, type QueryVector } from "../src/embed";
import { clip, trimSpace } from "../src/memory/clean";

// Each text is placed on the axes of the topics it mentions, so texts about
// the same topic are close even when they share no words, and gets a small
// component on an axis of its own, so texts about no known topic are close
// to nothing. It checks the plumbing, not search quality.
const topics = [
  ["猫", "cat", "feline", "kitten"],
  ["部署", "上线", "deploy", "release"],
  ["纠正", "误解", "corrected", "misunderstood"],
];
const ownAxes = 1024;
export const topicDims = topics.length + ownAxes;

function fnv32a(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

export function topicVector(text: string): number[] {
  const v = new Array<number>(topicDims).fill(0);
  v[topics.length + (fnv32a(text) % ownAxes)] = 0.05;
  const lower = text.toLowerCase();
  topics.forEach((words, axis) => {
    if (words.some((w) => lower.includes(w))) v[axis] = 1;
  });
  return v;
}

export const topicSettings: EmbedSettings = { model: "topic-test", dims: topicDims, minSimilarity: 0.45, queryTimeoutMs: 2000, queryHedgeMs: 1000 };

// TopicEmbedder counts its calls and texts; down fails every call, refuse
// fails any call with a text containing it, as an over-long input would be.
export class TopicEmbedder implements Embedder {
  down = false;
  refuse = "";
  documentCalls = 0;
  documentTexts = 0;
  queryCalls = 0;
  queryTexts = 0;

  async documents(texts: string[]): Promise<number[][]> {
    this.documentCalls++;
    this.documentTexts += texts.length;
    if (this.down) throw new Error("connection refused");
    if (this.refuse !== "" && texts.some((t) => t.includes(this.refuse))) throw new Error("input is too large");
    return texts.map(topicVector);
  }

  async queries(texts: string[]): Promise<number[][]> {
    this.queryCalls++;
    this.queryTexts += texts.length;
    if (this.down) throw new Error("connection refused");
    return texts.map(topicVector);
  }
}

// queryVectorOf is what the Worker hands the object for a query, made
// without waiting: the stand-in's vector, prepared as embedQuery prepares it.
export function queryVectorOf(query: string, s: EmbedSettings = topicSettings): QueryVector {
  return { model: s.model, dims: s.dims, values: prepare(topicVector(clip(trimSpace(query), 500)), s.dims) };
}

// A call the fake binding received: the model, which input form, and
// figures. The texts themselves are kept for the checks of what is sent.
export interface AiCall {
  model: string;
  form: "documents" | "queries" | "text";
  texts: string[];
  instruction?: string;
  signal: boolean;
}

// FakeAI stands in for env.AI. It answers { data, shape } with the topic
// vectors; delay holds each answer back (an abort ends the wait with an
// error), and fail makes every call throw.
export class FakeAI {
  calls: AiCall[] = [];
  delay = 0;
  fail = false;

  async run(model: string, inputs: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> {
    const form = "documents" in inputs ? "documents" : "queries" in inputs ? "queries" : "text";
    const raw = inputs[form];
    const texts = Array.isArray(raw) ? raw.map(String) : [String(raw)];
    const instruction = typeof inputs.instruction === "string" ? inputs.instruction : undefined;
    this.calls.push({ model, form, texts, ...(instruction === undefined ? {} : { instruction }), signal: options?.signal !== undefined });
    if (this.delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.delay);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
    }
    if (this.fail) throw new Error("model unavailable");
    const data = texts.map(topicVector);
    return { data, shape: [data.length, topicDims] };
  }

  asAi(): Ai {
    return this as unknown as Ai;
  }
}

// farFuture is where tests put the object's alarm clock, so that no alarm
// runs unless a test runs it.
export const farFuture = Date.UTC(2100, 0, 1);
