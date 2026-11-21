#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { AppServer } from './app-server.mjs';
import { ZiwoHost } from './host.mjs';
import { FileJournal } from './journal.mjs';

if (!process.stdin.isTTY || process.argv.length !== 3) {
  console.error('Usage: node adapters/codex/cli.mjs /absolute/path/to/private-config.json (interactive terminal required)'); process.exit(1);
}
const path = resolve(process.argv[2]), config = JSON.parse(await readFile(path, 'utf8'));
const journal = await FileJournal.open(path + '.journal');
let server;
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  server = await AppServer.start();
  const host = new ZiwoHost({ server, ...config, journal }); let threadId = await host.create(), review;
  const subjects = config.subjects ?? [];
  console.log('Ziwo reference Codex client. Current conversation: ' + threadId);
  console.log('Controls: /new, /resume ID, /fork, /subjects, /activate NUMBER, /evaluate NUMBER, /review NUMBER PROPOSAL_ID, /approve, /reject, /quit.');
  console.log('This reference client supports conversation and scoped memory tools; filesystem execution is disabled.');
  const admin = async (endpoint, body) => {
    if (!config.adminToken) throw new Error('Persona review requires a separate adminToken in the private config.');
    const r = await fetch(new URL(endpoint, config.url), { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error); return data;
  };
  for (;;) {
    const line = await terminal.question('> ');
    if (line === '/quit') break;
    try {
      if (line === '/subjects') { subjects.forEach((s, i) => console.log(`${i + 1}. ${s.label ?? s.memory} (${s.identityId})`)); continue; }
      if (line === '/new') { threadId = await host.create(); console.log(threadId); continue; }
      if (line.startsWith('/resume ')) { threadId = await host.resume(line.slice(8).trim()); console.log(threadId); continue; }
      if (line === '/fork') { threadId = await host.fork(threadId); console.log(threadId); continue; }
      const select = /^\/(activate|evaluate|review) (\d+)(?: ([A-Za-z0-9_.:-]+))?$/.exec(line);
      if (select) {
        const target = subjects[Number(select[2]) - 1]; if (!target) throw new Error('Select a listed subject number.');
        const { memory, identityId, instance } = target;
        if (select[1] === 'activate') { const result = await host.activate(threadId, { memory, identityId, instance }); console.log(result.historyIncomplete ? 'Activated with recorded history gaps.' : 'Activated.'); }
        else if (select[1] === 'evaluate') console.log(JSON.stringify(await host.evaluate({ memory, identityId, instance }), null, 2));
        else {
          if (!select[3]) throw new Error('A proposal ID is required.');
          const endpoint = `/admin/persona/${memory}/proposals/${select[3]}`;
          const proposal = await admin(endpoint); console.log(JSON.stringify(proposal, null, 2));
          review = { endpoint, exact: { identityId, instance, digest: proposal.digest } };
          console.log('Use /approve to confirm and adopt this exact proposal, or /reject.');
        }
        continue;
      }
      if (line === '/approve' || line === '/reject') {
        if (!review) throw new Error('Review a concrete proposal first.');
        await admin(review.endpoint + '/confirm', { ...review.exact, confirmationId: randomUUID(), decision: line === '/approve' ? 'approve' : 'reject' });
        if (line === '/approve') await admin(review.endpoint + '/adopt', review.exact);
        console.log(line === '/approve' ? 'Adopted. Bound conversations load the revision on their next turn.' : 'Rejected.'); review = undefined; continue;
      }
      console.log((await host.turn(threadId, line)).text);
    } catch (error) { console.error(error.message); }
  }
} finally { terminal.close(); await server?.dispose(); await journal.close(); }
