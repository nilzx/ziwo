import { readFile, realpath, lstat, mkdtemp, rm, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AppServer } from '../app-server.mjs';
import { ZiwoHost } from '../host.mjs';
import { FileJournal } from '../journal.mjs';
import { assertPrivateFiles } from '../workspace.mjs';
import { NativeGateway } from './gateway.mjs';
import { listenNative } from './transport.mjs';

const runtimeCandidates = ['/opt/homebrew', '/usr/local/bin', '/usr/local/lib', '/usr/local/Cellar', '/usr/local/opt', '/Library/Developer/CommandLineTools', '/Applications/Xcode.app'];
async function defaultRuntimeRoots() {
  const roots = [];
  for (const path of runtimeCandidates) try { await access(path); roots.push(path); } catch {}
  return roots;
}

export async function openNativeSession({ configPath, workspace, subject, resume, binary = 'codex', onError }) {
  const path = await realpath(resolve(configPath)), privateRoot = dirname(path), root = await realpath(resolve(workspace));
  for (const p of [privateRoot, path]) {
    const info = await lstat(p);
    if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Use an owner-only private directory and configuration (0700 / 0600)');
  }
  await assertPrivateFiles([privateRoot]);
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (typeof config.token !== 'string' || !config.token) throw new Error('A registered host token is required');
  const target = subject == null ? null : config.subjects?.[subject - 1];
  if (subject != null && (!Number.isInteger(subject) || subject < 1 || !target)) throw new Error('Select a configured subject number');
  let journal, server, transport, runDirectory, clientHome;
  try {
    journal = await FileJournal.open(path + '.native.journal');
    runDirectory = await mkdtemp(join(privateRoot, 'run-'));
    clientHome = await mkdtemp(join(tmpdir(), 'ziwo-native-ui-'));
    const socket = join(runDirectory, 'codex.sock');
    if (Buffer.byteLength(socket) > 100) throw new Error('Private configuration path is too long for a Unix socket; use a shorter dedicated directory');
    server = await AppServer.start({ binary, workspace: root, privatePaths: [privateRoot], runtimeStatePaths: [clientHome], runtimeRoots: config.runtimeRoots ?? await defaultRuntimeRoots() });
    const hostOptions = { url: config.url, token: config.token, model: config.model ?? 'gpt-6.1-terra' };
    const host = new ZiwoHost({ ...hostOptions, server, journal, execution: server.workspacePolicy.thread, preloadContext: true, turnTimeout: 30 * 60 * 1000,
      beforeTurn: () => assertPrivateFiles(server.workspacePolicy.audited),
      cleanHostFactory: async () => {
        const cleanServer = await AppServer.start({ binary });
        return { host: new ZiwoHost({ ...hostOptions, server: cleanServer }), close: () => cleanServer.dispose() };
      } });
    const gateway = new NativeGateway({ host, server, workspace: root, journal, onError, clientHome });
    let threadId;
    if (resume) {
      const record = await gateway.known(resume);
      if (target && !record.identityId) throw new Error('This native release activates new conversations only; start a new conversation with --subject');
      if (target && record.identityId !== target.identityId) throw new Error('This conversation is already bound; switching identities is forbidden');
      threadId = await host.resume(resume);
    } else threadId = await host.create({ persistNeutral: !target });
    gateway.verifyExecution(host.lastThreadResponse);
    await gateway.rememberWorkspace(threadId);
    if (target) await host.activate(threadId, { memory: target.memory, identityId: target.identityId, instance: target.instance });
    await gateway.rememberWorkspace(threadId);
    transport = await listenNative(gateway, socket);
    return { host, server, gateway, journal, threadId, workspace: root, socket, model: host.model, clientHome,
      async close() { await transport.close(); await server.dispose(); await journal.close(); await rm(runDirectory, { recursive: true, force: true }); await rm(clientHome, { recursive: true, force: true }); } };
  } catch (error) {
    await transport?.close(); await server?.dispose(); await journal?.close();
    if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
    if (clientHome) await rm(clientHome, { recursive: true, force: true });
    throw error;
  }
}
