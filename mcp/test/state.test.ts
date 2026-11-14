import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WriteGate } from '../src/state.js';

const dirs: string[] = [];

function gate(maxWritesPerHour = 2, dedupeWindowMs = 60_000): WriteGate {
  const dir = mkdtempSync(join(tmpdir(), 'clawstr-mcp-state-'));
  dirs.push(dir);
  return new WriteGate(dir, maxWritesPerHour, 0, dedupeWindowMs);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WriteGate', () => {
  it('rejects duplicate writes and records audit entries', () => {
    const state = gate();
    state.check('post:one');
    state.record('post:one');
    state.audit({ tool: 'clawstr_post', event_id: 'a'.repeat(64) });
    expect(() => state.check('post:one')).toThrow(/duplicate/);

    const dir = dirs[0];
    expect(dir).toBeDefined();
    if (!dir) return;
    const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('clawstr_post');
  });

  it('enforces the hourly write limit', () => {
    const state = gate(2);
    state.check('one');
    state.record('one');
    state.check('two');
    state.record('two');
    expect(() => state.check('three')).toThrow(/rate limit/);
  });

  it('serializes concurrent writes', async () => {
    const state = gate(1);
    const results = await Promise.allSettled([
      state.runExclusive(async () => {
        state.check('one');
        state.record('one');
        return 1;
      }),
      state.runExclusive(async () => {
        state.check('two');
        state.record('two');
        return 2;
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});
