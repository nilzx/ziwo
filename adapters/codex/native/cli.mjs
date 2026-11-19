#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { openNativeSession } from './session.mjs';

const usage = 'Usage: node adapters/codex/native/cli.mjs --config /private/host/config.json --workspace /path/to/code [--subject 1] [--resume THREAD_ID]';
let session;
try {
  const { values } = parseArgs({ options: { config: { type: 'string' }, workspace: { type: 'string' }, subject: { type: 'string' }, resume: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(usage); process.exit(0); }
  if (!process.stdin.isTTY || !process.stdout.isTTY || !values.config || !values.workspace) throw new Error(usage + '\nAn interactive terminal is required.');
  session = await openNativeSession({ configPath: values.config, workspace: values.workspace, subject: values.subject == null ? undefined : Number(values.subject), resume: values.resume,
    onError: ({ method, message }) => console.error('Ziwo ' + method + ': ' + message) });
  console.log('Ziwo native Codex workspace. Conversation: ' + session.threadId);
  console.log('Use this launcher to resume; native /new starts an unbound conversation.');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/ZIWO|ADMIN_SECRET|OPENAI_API_KEY/.test(key)));
  env.CODEX_HOME = session.clientHome;
  const child = spawn('codex', ['--remote', 'unix://' + session.socket, '--no-alt-screen',
    '-m', session.model, '-C', session.workspace, 'resume', session.threadId], { stdio: 'inherit', env });
  const stop = () => { child.kill('SIGTERM'); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await session?.close(); }
