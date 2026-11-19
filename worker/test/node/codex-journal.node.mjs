import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileJournal } from '../../../adapters/codex/journal.mjs';

test('concurrent conversation registrations persist without losing provenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ziwo-journal-test-')), path = join(dir, 'journal');
  let journal = await FileJournal.open(path);
  try {
    await Promise.all(Array.from({ length: 10 }, (_, i) => journal.set(`thread:${i}`, { source: 'conversation', number: i })));
    await journal.close(); journal = await FileJournal.open(path);
    for (let i = 0; i < 10; i++) assert.equal(journal.get(`thread:${i}`).number, i);
    await assert.rejects(FileJournal.open(path), { code: 'EEXIST' });
  } finally { await journal.close(); await rm(dir, { recursive: true, force: true }); }
});
