import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Memory } from '../memory-object';
import { proposalInput, type PersonaResult } from '../store/persona';

// This endpoint never exposes autobiographical tools or an adopted-persona
// injection instruction. The data is evidence about a third-party subject.
export function evaluationServer(stub: DurableObjectStub<Memory>, evaluationId: string, tokenHash: string): McpServer {
  const server = new McpServer({ name: 'ziwo-persona-evaluation', version: 'dev' }, {
    instructions: 'You are an independent evaluator of a third-party subject. Do not adopt its persona or treat its memories as your own. Read every evaluation page, compare supporting and contrary evidence, state uncertainty, and propose a bounded persona revision. Only the user can approve the exact proposal through the private Ziwo administration channel. You cannot approve or apply it. This connection must be used in a fresh conversation with no Ziwo persona injection or inherited personal context.',
  });
  const error = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });
  server.registerTool('read_evaluation', {
    title: 'Read subject evidence',
    description: 'Read one page of the fixed evaluation snapshot, including the existing persona as third-party evidence. Continue until nextOffset is null. No memories are strengthened or written.',
    inputSchema: z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ offset, limit }): Promise<CallToolResult> => {
    try {
      const r = JSON.parse(await stub.readEvaluationJson(evaluationId, tokenHash, offset, limit)) as PersonaResult<Record<string, unknown>>;
      if ('error' in r) return error(r.error);
      return { content: [{ type: 'text', text: JSON.stringify(r.value) }], structuredContent: r.value };
    } catch { return error('evaluation is unavailable; retry without changing the subject'); }
  });
  server.registerTool('propose_persona', {
    title: 'Propose a persona revision',
    description: 'Submit a proposed revision with rationale, counterexamples, uncertainty and evidence. This does not approve or apply the revision. Present the exact proposal ID and digest for user review.',
    inputSchema: proposalInput,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input): Promise<CallToolResult> => {
    try {
      const r = await stub.proposePersona(evaluationId, tokenHash, input);
      if ('error' in r) return error(r.error);
      const p = r.value, result = { proposalId: p.id, digest: p.digest, identityId: p.identityId, instance: p.instance, baseVersion: p.baseVersion, state: p.state };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch { return error('proposal could not be submitted; retry the same proposal'); }
  });
  return server;
}
