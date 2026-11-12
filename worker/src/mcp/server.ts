// The MCP server of one memory for one request. It runs in the Worker; each
// tool call checks its arguments here and is carried out by the memory's
// Durable Object in one RPC.

import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { type QueryEmbedding, queryMaxRunes } from "../embed";
import { clip, queryParts, trimSpace } from "../memory/clean";
import type { Memory } from "../memory-object";
import { check, type Fault, faultOf, instructions, listed, tools } from "./tools";
import { logLine } from "../log";

export const serverVersion = "dev";

// internalError is what the model is told when something other than its
// input went wrong. The details go nowhere: an error's text may quote what
// a memory says.
export const internalError = "the memory server hit an internal error; nothing was changed";

// Call is what the server knows about the request it serves.
export interface Call {
  memory: string; // the memory's name
  client: string; // the client's name, for get_context
  stub: DurableObjectStub<Memory>;
  // Embeds a recall's query within its time limit; absent when search by
  // meaning is off. The object never embeds a query itself.
  embedQuery?: (query: string) => Promise<QueryEmbedding>;
  // The instance of the memory an OAuth grant was given for, when the grant
  // recorded one: the object refuses a call made for another instance, a
  // memory deleted and created again under the same name.
  instance?: string;
}

// RecallShape is what the access log says of a recall: by subject or by
// time, how many parts of the query were searched on their own (1 for a
// query that names one thing, 0 for a listing by time), and which ends of a
// span were given.
interface RecallShape {
  by: "subject" | "time";
  parts: number;
  span: "none" | "since" | "until" | "both";
}

function recallShape(c: { query: string; since?: string; until?: string }): RecallShape {
  const query = clip(trimSpace(c.query), queryMaxRunes);
  const since = trimSpace(c.since ?? "") !== "";
  const until = trimSpace(c.until ?? "") !== "";
  const n = query === "" ? 0 : queryParts(query).length;
  return {
    by: query === "" ? "time" : "subject",
    parts: query === "" ? 0 : n >= 2 ? n : 1,
    span: since && until ? "both" : since ? "since" : until ? "until" : "none",
  };
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// buildServer returns a server with the eight tools, bound to one memory.
export function buildServer(call: Call): McpServer {
  const server = new McpServer({ name: "ziwo", version: serverVersion }, { instructions });
  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: listed(def),
        annotations: def.annotations,
        ...(def.meta !== undefined ? { _meta: def.meta } : {}),
      },
      async (raw: unknown): Promise<CallToolResult> => {
        const start = Date.now();
        let outcome: "ok" | "invalid" | "error" = "ok";
        let failed = "";
        let fault: Fault | undefined;
        let embedded: QueryEmbedding["took"];
        let recalled: RecallShape | undefined;
        try {
          const checked = check(def, raw, call.client);
          if ("invalid" in checked) {
            outcome = "invalid";
            fault = faultOf(def, checked.invalid);
            return toolError(checked.invalid);
          }
          let toolCall = checked.ok;
          if (toolCall.tool === "recall") recalled = recallShape(toolCall);
          if (toolCall.tool === "recall" && call.embedQuery !== undefined) {
            const meaning = await call.embedQuery(toolCall.query);
            embedded = meaning.took;
            if (meaning.vector !== undefined) toolCall = { ...toolCall, meaning: meaning.vector };
          }
          const answer = await call.stub.answer(toolCall, call.instance);
          if ("gone" in answer) {
            // The memory was deleted, or deleted and made again, after the
            // credential was checked: the existing words for a failure.
            outcome = "error";
            failed = "NoSuchMemory";
            return toolError(internalError);
          }
          if ("invalid" in answer) {
            outcome = "invalid";
            fault = faultOf(def, answer.invalid);
            return toolError(answer.invalid);
          }
          return { content: [{ type: "text", text: answer.text }] };
        } catch (err) {
          outcome = "error";
          // The kind of error only: its text may quote what a memory says.
          failed = err instanceof Error ? err.name : "unknown";
          return toolError(internalError);
        } finally {
          logLine({
            msg: "tool", memory: call.memory, tool: def.name, outcome, dur_ms: Date.now() - start,
            ...(failed === "" ? {} : { error: failed }),
            // What a refused call was refused for, in fixed words.
            ...(fault === undefined ? {} : { invalid_field: fault.field, invalid_kind: fault.kind }),
            // Figures and fixed words about the query's embedding, never the query.
            ...(embedded === undefined ? {} : { embed_ms: embedded.ms, embed_second: embedded.second, embed_answer: embedded.answer }),
            // What kind of recall it was, in fixed words and a figure.
            ...(recalled === undefined ? {} : { recall_by: recalled.by, recall_parts: recalled.parts, recall_span: recalled.span }),
          });
        }
      },
    );
  }
  return server;
}
