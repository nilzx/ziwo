import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspacePolicy, profileFlags } from './workspace.mjs';

// A deliberately narrow reference transport. Host credentials never enter the
// child environment. It exposes no shell, inherited MCP, apps, or native agents.
const disabled = ['apps', 'plugins', 'remote_plugin', 'memories', 'chronicle', 'hooks', 'shell_tool', 'unified_exec',
  'multi_agent', 'multi_agent_v2', 'js_repl', 'skill_search', 'skill_mcp_dependency_install',
  'view_image', 'image_generation', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use'];
const baseFlags = [...disabled.flatMap(f => ['-c', `features.${f}=false`]),
  '-c', 'features.skip_host_skill_discovery=true', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"'];

export class AppServer {
  #pending = new Map(); #events = []; #waiters = []; #seq = 0;
  constructor(process, cwd) {
    this.process = process; this.cwd = cwd; this.onRequest = async () => { throw new Error('unsupported server request'); };
    process.stdin.on('error', () => {}); // Late tool replies after shutdown have no recipient.
    this.notifications = [];
    createInterface({ input: process.stdout }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        Promise.resolve(this.onRequest(message.method, message.params)).then(
          result => this.send({ id: message.id, result }),
          () => this.send({ id: message.id, error: { code: -32601, message: 'Request is not authorized by this host.' } }));
      } else if (message.id !== undefined) {
        const p = this.#pending.get(message.id); if (!p) return;
        this.#pending.delete(message.id); clearTimeout(p.timer);
        message.error ? p.reject(new Error(`App Server ${p.method} failed: ${message.error.message}`)) : p.resolve(message.result);
      } else {
        this.onNotification?.(message);
        // Do not persist raw notifications: they may contain autobiographical data.
        this.notifications.push(message.method);
        const i = this.#waiters.findIndex(w => w.predicate(message));
        if (i >= 0) { const [w] = this.#waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(message); }
        else if (message.method === 'turn/completed') this.#events.push(message);
      }
    });
    process.on('exit', () => {
      for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error('App Server exited')); }
      for (const w of this.#waiters) { clearTimeout(w.timer); w.reject(new Error('App Server exited')); }
      this.#pending.clear(); this.#waiters = [];
    });
    process.on('error', () => {
      for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error('App Server could not start')); }
      this.#pending.clear();
    });
    process.stderr.resume(); // Never forward potentially sensitive config diagnostics.
  }
  send(value) { if (!this.process.stdin.destroyed) this.process.stdin.write(JSON.stringify(value) + '\n'); }
  request(method, params = {}, timeout = 180000) {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`App Server ${method} timed out`)); }, timeout);
      this.#pending.set(id, { resolve, reject, timer, method }); this.send({ id, method, params });
    });
  }
  wait(predicate, timeout = 180000) {
    const index = this.#events.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.#events.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => { this.#waiters = this.#waiters.filter(w => w !== waiter); reject(new Error('App Server turn timed out')); }, timeout);
      this.#waiters.push(waiter);
    });
  }
  completed(threadId, turnId, timeout = 180000) { return this.wait(e => e.method === 'turn/completed' && e.params.threadId === threadId && e.params.turn.id === turnId, timeout).then(e => e.params.turn); }
  async close() {
    if (!this.process.pid || this.process.exitCode !== null || this.process.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => this.process.kill('SIGKILL'), 5000);
      this.process.once('exit', () => { clearTimeout(timer); resolve(); });
      this.process.kill();
    });
  }
  static async start({ binary = 'codex', workspace, privatePaths = [], runtimeStatePaths = [], runtimeRoots = [] } = {}) {
    const temporary = await mkdtemp(join(tmpdir(), 'ziwo-codex-'));
    const cwd = workspace ?? temporary;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/ZIWO|ADMIN_SECRET|OPENAI_API_KEY/.test(k)));
    const modeFlags = workspace ? [...baseFlags, '-c', 'features.shell_tool=true', '-c', 'features.unified_exec=true',
      '-c', 'shell_environment_policy={inherit="none",set={PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",TMPDIR=' + JSON.stringify(temporary) + '}}'] : baseFlags;
    const open = async flags => {
      const child = spawn(binary, ['app-server', ...modeFlags, ...flags], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const rpc = new AppServer(child, cwd);
      try {
        const initialized = await rpc.request('initialize', { clientInfo: { name: 'ziwo-codex-reference', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        rpc.runtimeInfo = { userAgent: initialized.userAgent ?? 'unknown' };
        rpc.initialized = initialized;
        rpc.send({ method: 'initialized', params: {} }); return rpc;
      } catch (error) { await rpc.close(); throw error; }
    };
    let rpc;
    try {
      // Config inspection starts no thread and invokes no model or MCP tool.
      rpc = await open([]);
      const { config } = await rpc.request('config/read', { includeLayers: false, cwd });
      const flags = [];
      const policy = workspace ? await workspacePolicy(workspace, [...privatePaths, ...runtimeStatePaths, rpc.initialized.codexHome], { runtimeRoots, scratch: temporary, credentialRoot: rpc.initialized.codexHome, runtimeStatePaths }) : null;
      if (policy) flags.push(...profileFlags(policy));
      for (const key of Object.keys(config.mcp_servers ?? {})) {
        if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('Unsupported MCP configuration key; use an explicitly isolated Codex configuration');
        flags.push('-c', `mcp_servers.${key}.enabled=false`);
      }
      for (const key of Object.keys(config.plugins ?? {})) flags.push('-c', `plugins.${JSON.stringify(key)}.enabled=false`);
      await rpc.close(); rpc = await open(flags);
      const checked = (await rpc.request('config/read', { includeLayers: false, cwd })).config;
      if (Object.values(checked.mcp_servers ?? {}).some(s => s.enabled !== false)) throw new Error('inherited MCP configuration could not be disabled');
      if (checked.features?.plugins !== false || checked.features?.apps !== false || checked.features?.shell_tool !== Boolean(workspace)) throw new Error('required host isolation settings were not applied');
      rpc.workspacePolicy = policy;
      rpc.dispose = async () => { await rpc.close(); await rm(temporary, { recursive: true, force: true }); };
      return rpc;
    } catch (error) { await rpc?.close(); await rm(temporary, { recursive: true, force: true }); throw error; }
  }
}
