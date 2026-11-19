import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
// Only source IDs, fingerprints and host-owned conversation provenance are
// saved here. No persona, history text, memory content, or credential is saved.
export class FileJournal {
  #pending = Promise.resolve();
  constructor(path, entries, lock) { this.path = path; this.entries = entries; this.lock = lock; }
  static async open(path) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lock = await open(path + '.lock', 'wx', 0o600);
    let entries = {};
    try { entries = JSON.parse(await readFile(path, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') { await lock.close(); await unlink(path + '.lock'); throw e; } }
    return new FileJournal(path, entries, lock);
  }
  get(key) { return this.entries[key]; }
  set(key, value) {
    const write = this.#pending.then(async () => {
      const next = { ...this.entries, [key]: value };
      await writeFile(this.path + '.tmp', JSON.stringify(next), { mode: 0o600 });
      await rename(this.path + '.tmp', this.path);
      this.entries = next;
    });
    this.#pending = write.catch(() => {});
    return write;
  }
  async close() { await this.#pending; await this.lock.close(); await unlink(this.path + '.lock'); }
}
