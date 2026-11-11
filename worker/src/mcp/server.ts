// The MCP server of one memory for one request. It runs in the Worker; each
// tool call checks its arguments here and is carried out by the memory's
// Durable Object in one RPC.

import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { QueryVector } from "../embed";
import type { Memory } from "../memory-object";
import { check, instructions, listed, tools } from "./tools";
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
  embedQuery?: (query: string) => Promise<QueryVector | undefined>;
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
        try {
          const checked = check(def, raw, call.client);
          if ("invalid" in checked) {
            outcome = "invalid";
            return toolError(checked.invalid);
          }
          let toolCall = checked.ok;
          if (toolCall.tool === "recall" && call.embedQuery !== undefined) {
            const meaning = await call.embedQuery(toolCall.query);
            if (meaning !== undefined) toolCall = { ...toolCall, meaning };
          }
          const answer = await call.stub.answer(toolCall);
          if ("invalid" in answer) {
            outcome = "invalid";
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
          });
        }
      },
    );
  }
  return server;
}
