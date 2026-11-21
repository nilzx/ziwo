import { realpath, stat, readdir, lstat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export const workspaceProfile = 'ziwo-workspace';
export const within = (root, path) => { const p = relative(root, path); return p === '' || p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p); };

export async function assertPrivateFiles(paths) {
  let seen = 0;
  const visit = async path => {
    if (++seen > 20000) throw new Error('Private state directory is too large; use a dedicated host directory');
    const s = await lstat(path);
    if (s.isSymbolicLink() || (s.isFile() || s.isSocket()) && s.nlink !== 1) throw new Error('Private state contains a symbolic or hard link');
    if (s.isDirectory()) for (const entry of await readdir(path)) await visit(path + sep + entry);
    else if (!s.isFile() && !s.isSocket()) throw new Error('Unsupported private state file');
  };
  for (const path of paths) await visit(path);
}

export async function workspacePolicy(workspace, privatePaths, { runtimeRoots = [], scratch, credentialRoot, runtimeStatePaths = [] } = {}) {
  if (!isAbsolute(workspace)) throw new Error('Workspace must be absolute');
  const root = await realpath(workspace);
  if (!(await stat(root)).isDirectory()) throw new Error('Workspace must be a directory');
  const denied = [];
  for (const path of privatePaths) {
    if (!isAbsolute(path)) throw new Error('Private paths must be absolute');
    const resolved = await realpath(path);
    if (within(root, resolved) || within(resolved, root)) throw new Error('Keep private host state outside the workspace');
    denied.push(resolved);
  }
  if (!denied.length) throw new Error('Workspace execution requires explicit private state protection');
  // A separate credential-free UI cache contains Codex-created executable
  // symlinks. It remains denied, but is not a credential link-audit root.
  const audited = privatePaths.filter(p => p !== credentialRoot && !runtimeStatePaths.includes(p));
  if (credentialRoot) for (const filename of await readdir(credentialRoot)) {
    if (filename === 'auth.json' || filename.endsWith('config.toml')) audited.push(credentialRoot + sep + filename);
  }
  await assertPrivateFiles(audited);
  const filesystem = { ':root': 'deny', ':minimal': 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny',
    ':workspace_roots': { '.': 'write', '.git': 'write', '.codex': 'read', '.agents': 'read', '.aws': 'read' } };
  for (const path of denied) filesystem[path] = 'deny';
  for (const path of runtimeRoots) {
    const resolved = await realpath(path);
    if (denied.some(p => within(p, resolved) || within(resolved, p))) throw new Error('A runtime path cannot overlap private state');
    filesystem[resolved] = 'read';
  }
  if (scratch) filesystem[await realpath(scratch)] = 'write';
  return { root, denied, audited, profile: { extends: ':workspace', filesystem, network: { enabled: false } },
    thread: { cwd: root, runtimeWorkspaceRoots: [root], permissions: workspaceProfile, approvalPolicy: 'never' } };
}

export function profileFlags(policy) {
  const encode = v => typeof v === 'string' ? JSON.stringify(v) : typeof v === 'boolean' ? String(v) :
    '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + '=' + encode(x)).join(',') + '}';
  return ['-c', 'permissions.' + workspaceProfile + '=' + encode(policy.profile), '-c', 'default_permissions=' + JSON.stringify(workspaceProfile)];
}
