import { realpath } from 'node:fs/promises';
import { within, workspaceProfile } from '../workspace.mjs';

const fail = message => { throw new Error(message); };
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : fail('Invalid thread ID');
const readMethods = new Set(['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/items/read']);
const harmless = new Set(['model/list', 'account/rateLimits/read', 'account/read', 'configRequirements/read', 'collaborationMode/list', 'experimentalFeature/list']);
const emptyFeatures = new Map([
  ['skills/list', { data: [] }], ['hooks/list', { data: [] }], ['mcpServerStatus/list', { data: [], nextCursor: null }],
  ['app/list', { data: [], nextCursor: null }], ['app/installed', { data: [] }], ['plugin/list', { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }],
]);

// This is the native client's transport boundary, not an MCP tool. Every
// unhandled RPC is rejected; forwarding arbitrary App Server RPCs bypasses sync.
export class NativeGateway {
  constructor({ host, server, workspace, journal, onError = () => {}, clientHome }) {
    this.host = host; this.server = server; this.workspace = workspace; this.journal = journal; this.onError = onError; this.clientHome = clientHome;
    this.operations = new Map(); this.holds = new Map(); this.outbound = () => {}; this.connected = false; this.connection = 0;
    this.stats = { acceptedTurns: 0, refusedRequests: 0, initialized: false };
    const previous = server.onNotification;
    server.onNotification = event => { previous?.(event); this.notification(event); };
    const dispatch = server.onRequest;
    server.onRequest = (method, params) => {
      if (method === 'item/tool/call') return dispatch(method, params);
      // Workspace execution never accepts unsandboxed approval, profile
      // expansion, or persistent exec-policy amendments from either surface.
      throw new Error('This workspace does not grant permission escalation or unscoped client actions');
    };
  }
  attach(send) { if (this.connected) fail('One native client may attach at a time'); this.connected = true; this.connection++; this.stats.initialized = false; this.outbound = send; }
  async detach() {
    this.connected = false; this.connection++; this.holds.clear();
    for (const [threadId, op] of this.operations) if (op.turnId) await this.server.request('turn/interrupt', { threadId, turnId: op.turnId }).catch(() => {});
  }
  notification(event) {
    const threadId = event.params?.threadId ?? event.params?.thread?.id;
    if (!threadId || !this.host.owns(threadId)) return;
    if (event.method === 'item/completed' && event.params?.item?.type === 'contextCompaction') this.host.reload(threadId);
    const hold = this.holds.get(threadId);
    if (hold) {
      if (hold.length > 10000) { this.detach(); return; }
      hold.push(event); return;
    }
    if (this.connected) this.outbound(event);
  }
  async known(threadId) {
    safeId(threadId);
    const record = await this.journal.get('thread:' + threadId);
    if (record?.source !== 'conversation' || record.url !== this.host.url || record.workspace !== this.workspace) fail('Only conversations created for this host and workspace are available');
    return record;
  }
  async rememberWorkspace(threadId) {
    const record = await this.journal.get('thread:' + threadId);
    await this.journal.set('thread:' + threadId, { ...record, workspace: this.workspace });
  }
  overrides(params) {
    const contextFields = ['path', 'history', 'additionalContext', 'baseInstructions', 'developerInstructions'].filter(k => params[k] != null);
    if (params.dynamicTools != null && (!Array.isArray(params.dynamicTools) || params.dynamicTools.length)) contextFields.push('dynamicTools');
    // The native TUI always echoes its local reasoning preference on resume.
    // It is accepted for compatibility, but is never applied to the backend.
    if (params.config != null && (typeof params.config !== 'object' || Array.isArray(params.config) || Object.keys(params.config).some(k => k !== 'model_reasoning_effort'))) contextFields.push('config (' + Object.keys(params.config).join(', ') + ')');
    if (contextFields.length || params.environments?.length || params.selectedCapabilityRoots?.length) fail('Client context and runtime overrides are not supported by this host: ' + contextFields.join(', '));
    if (params.cwd && params.cwd !== this.workspace) fail('Changing workspace requires a new host');
    if (params.model && params.model !== this.host.model) fail('Restart the host to select another model');
    if (params.runtimeWorkspaceRoots != null && (!Array.isArray(params.runtimeWorkspaceRoots) || params.runtimeWorkspaceRoots.length > 0 && (params.runtimeWorkspaceRoots.length !== 1 || params.runtimeWorkspaceRoots[0] !== this.workspace))) fail('Workspace roots are fixed (received ' + params.runtimeWorkspaceRoots?.length + ' entries)');
    // Native clients send their local defaults. They are never forwarded;
    // thread/turn execution always uses the host's fixed named profile.
  }
  async handle(method, params = {}) {
    try { return await this.route(method, params ?? {}); }
    catch (error) { this.stats.refusedRequests++; this.onError({ method, message: error.message }); throw error; }
  }
  async route(method, p) {
    if (!this.connected) fail('Native client disconnected');
    if (method === 'initialize') { this.stats.initialized = true; return { ...this.server.initialized, ...(this.clientHome ? { codexHome: this.clientHome } : {}) }; }
    if (method === 'initialized') return {};
    if (!this.stats.initialized) fail('Initialize the native connection first');
    if (harmless.has(method)) return this.server.request(method, p);
    if (emptyFeatures.has(method)) return structuredClone(emptyFeatures.get(method));
    if (method === 'config/read') {
      const r = await this.server.request('config/read', { includeLayers: false, cwd: this.workspace });
      const allowed = ['model', 'model_provider', 'model_reasoning_effort', 'model_reasoning_summary', 'model_context_window', 'model_auto_compact_token_limit', 'service_tier', 'review_model', 'personality', 'features', 'tui'];
      const config = Object.fromEntries(allowed.filter(k => k in r.config).map(k => [k, r.config[k]]));
      return { origins: {}, layers: null, config: { ...config, projects: { [this.workspace]: { trust_level: 'trusted' } }, approval_policy: 'never', default_permissions: workspaceProfile } };
    }
    if (method === 'thread/start') {
      if (p.ephemeral) fail('Temporary assistants must use the separate clean assistance service');
      // The TUI supplies its frontend tool catalog even for /new. Never pass
      // it to the backend: ZiwoHost.create installs only the host-owned tools.
      const { dynamicTools: clientTools, ...settings } = p;
      if (clientTools != null && !Array.isArray(clientTools)) fail('Invalid native tool catalog');
      this.overrides(settings); const id = await this.host.create({ persistNeutral: true }); await this.rememberWorkspace(id); this.verifyExecution(this.host.lastThreadResponse); return this.host.lastThreadResponse;
    }
    if (method === 'thread/resume') {
      this.overrides(p); await this.known(p.threadId);
      await this.host.resume(p.threadId); this.verifyExecution(this.host.lastThreadResponse); return this.host.lastThreadResponse;
    }
    if (method === 'thread/fork') {
      this.overrides(p); await this.known(p.threadId);
      if (p.experimentalPredictionMode || p.ephemeral || p.attachToSource || p.lastTurnId || p.beforeTurnId || p.deferGoalContinuation) fail('Only full persistent conversation forks are supported');
      if (!this.host.owns(p.threadId)) await this.host.resume(p.threadId);
      const id = await this.host.fork(p.threadId); await this.rememberWorkspace(id); this.verifyExecution(this.host.lastThreadResponse); return this.host.lastThreadResponse;
    }
    if (method === 'thread/list') {
      const entries = this.journal instanceof Map ? [...this.journal] : this.journal.entries instanceof Map ? [...this.journal.entries] : Object.entries(this.journal.entries ?? {});
      const own = entries.filter(([key, r]) => key.startsWith('thread:') && r.workspace === this.workspace && r.url === this.host.url);
      const offset = p.cursor == null ? 0 : Number(p.cursor);
      if (!Number.isInteger(offset) || offset < 0) fail('Invalid thread list cursor');
      const selected = own.slice(offset, offset + 50), data = [];
      for (const [key] of selected) { const r = await this.server.request('thread/read', { threadId: key.slice(7), includeTurns: false }); data.push(r.thread); }
      return { data, readStates: null, nextCursor: offset + 50 < own.length ? String(offset + 50) : null, backwardsCursor: null };
    }
    if (method === 'thread/loaded/list') {
      const entries = this.journal.entries instanceof Map ? [...this.journal.entries] : this.journal instanceof Map ? [...this.journal] : Object.entries(this.journal.entries ?? {});
      return { data: entries.filter(([key, r]) => key.startsWith('thread:') && r.workspace === this.workspace && this.host.owns(key.slice(7))).map(([key]) => key.slice(7)), nextCursor: null };
    }
    if (readMethods.has(method)) { await this.known(p.threadId); if (p.path || p.history) fail('History overrides are forbidden'); return this.server.request(method, p); }
    if (method === 'thread/name/set' || method === 'thread/readState/update') { await this.known(p.threadId); return this.server.request(method, p); }
    if (method === 'thread/archive' || method === 'thread/unsubscribe' || method === 'thread/backgroundTerminals/list' || method === 'thread/backgroundTerminals/terminate' || method === 'thread/backgroundTerminals/clean') {
      await this.known(p.threadId); if (this.host.busy(p.threadId) || this.operations.has(p.threadId)) fail('Finish the current turn first'); return this.server.request(method, p);
    }
    if (method === 'turn/start') {
      this.overrides(p); await this.known(p.threadId);
      if (!this.host.owns(p.threadId)) fail('Resume this conversation before starting a turn');
      if (this.host.busy(p.threadId) || this.operations.has(p.threadId)) fail('Finish or interrupt the current turn before sending another message');
      if (!Array.isArray(p.input) || !p.input.length || p.input.some(i => !['text', 'image', 'localImage'].includes(i.type))) fail('Only native user text and image inputs are supported');
      for (const item of p.input) if (item.type === 'localImage' && !within(this.workspace, await realpath(item.path))) fail('Image must be inside the workspace');
      if (this.host.busy(p.threadId) || this.operations.has(p.threadId)) fail('Finish or interrupt the current turn before sending another message');
      const connection = this.connection, op = { turnId: null }; this.operations.set(p.threadId, op); this.holds.set(p.threadId, []);
      return new Promise((resolve, reject) => {
        const task = this.host.turn(p.threadId, null, { inputItems: p.input,
          beforeStart: () => { if (!this.connected || this.connection !== connection) fail('Native client disconnected before generation'); },
          onStarted: r => {
            op.turnId = r.turn.id; this.stats.acceptedTurns++; resolve(r);
            if (!this.connected || this.connection !== connection) this.server.request('turn/interrupt', { threadId: p.threadId, turnId: op.turnId }).catch(() => {});
            // The RPC response must precede corresponding notifications.
            setTimeout(() => { const events = this.holds.get(p.threadId) ?? []; this.holds.delete(p.threadId); if (this.connected && this.connection === connection) for (const e of events) this.outbound(e); }, 0);
          } });
        task.catch(error => { reject(error); }).finally(() => { this.operations.delete(p.threadId); if (!op.turnId) this.holds.delete(p.threadId); });
      });
    }
    if (method === 'turn/interrupt') {
      await this.known(p.threadId); const op = this.operations.get(p.threadId);
      if (!op?.turnId || p.turnId !== op.turnId) fail('Interrupt does not match the current turn'); return this.server.request(method, { threadId: p.threadId, turnId: p.turnId });
    }
    if (method === 'thread/compact/start') {
      await this.known(p.threadId); if (!this.host.owns(p.threadId) || this.host.busy(p.threadId) || this.operations.has(p.threadId)) fail('Compaction requires an attached idle conversation');
      this.operations.set(p.threadId, { turnId: null });
      try {
        const r = await this.server.request(method, { threadId: p.threadId });
        this.server.wait(e => e.method === 'turn/completed' && e.params.threadId === p.threadId).then(() => this.host.reload(p.threadId)).catch(() => {}).finally(() => this.operations.delete(p.threadId));
        return r;
      } catch (e) { this.operations.delete(p.threadId); throw e; }
    }
    fail('Unsupported native operation: ' + method + '. This path has not been verified with Ziwo synchronization.');
  }
  verifyExecution(r) {
    if (r.cwd !== this.workspace || r.activePermissionProfile?.id !== workspaceProfile || r.approvalPolicy !== 'never') fail('Codex did not retain the required workspace protection');
  }
}
