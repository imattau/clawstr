import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Event as NostrEvent, VerifiedEvent } from 'nostr-tools/core';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { ClawstrConfig } from '../src/config.js';
import type { RelayClient } from '../src/relay.js';
import type { ClawstrSigner } from '../src/signer.js';
import { WriteGate } from '../src/state.js';
import { WriteTools } from '../src/tools/write.js';

const dirs: string[] = [];
const SUBSCLAW = 'https://clawstr.com/c/nscript';

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(options: { allowWrites?: boolean; maxContentBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clawstr-mcp-write-'));
  dirs.push(dir);
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const target: NostrEvent = {
    id: 'a'.repeat(64),
    pubkey,
    kind: 1111,
    created_at: 1_794_625_393,
    tags: [
      ['I', SUBSCLAW],
      ['K', 'web'],
      ['i', SUBSCLAW],
      ['k', 'web'],
      ['L', 'agent'],
      ['l', 'ai', 'agent'],
    ],
    content: 'target',
    sig: 'b'.repeat(128),
  };
  const profile: NostrEvent = {
    id: 'c'.repeat(64),
    pubkey,
    kind: 0,
    created_at: 1_794_600_000,
    tags: [],
    content: JSON.stringify({ name: 'Old', about: 'Old about' }),
    sig: 'd'.repeat(128),
  };
  const published: VerifiedEvent[] = [];

  const client = {
    async getById(id: string) {
      return id === target.id ? target : null;
    },
    async query(filters: Array<{ kinds?: number[] }>) {
      return filters.some((filter) => filter.kinds?.includes(0)) ? [profile] : [target];
    },
    async publish(event: VerifiedEvent) {
      published.push(event);
      return [{ url: 'wss://relay.example', accepted: true }];
    },
    close() {},
  } as unknown as RelayClient;

  const signer: ClawstrSigner = {
    async getPublicKey() {
      return pubkey;
    },
    async signEvent(template) {
      return finalizeEvent(template, secret);
    },
    async close() {},
  };

  const config: ClawstrConfig = {
    relays: ['wss://relay.example'],
    allowedRelays: ['wss://relay.example'],
    allowWrites: options.allowWrites ?? true,
    keyFile: join(dir, 'secret.key'),
    stateDir: dir,
    requestTimeoutMs: 1_000,
    maxWritesPerHour: 100,
    minWriteIntervalMs: 0,
    dedupeWindowMs: 24 * 60 * 60 * 1_000,
    maxContentBytes: options.maxContentBytes ?? 16_384,
    clientName: 'test-client',
  };
  const gate = new WriteGate(dir, 100, 0, 24 * 60 * 60 * 1_000);
  const tools = new WriteTools(client, signer, gate, config);
  return { tools, published, target, pubkey };
}

describe('write tools', () => {
  it('publishes a post with the full Clawstr tag set', async () => {
    const { tools, published } = harness();
    const result = await tools.post({ subclaw: '/c/nscript', content: 'hello' });
    expect(result.url).toBe(`https://clawstr.com/c/nscript/post/${result.event_id}`);
    expect(published[0]?.kind).toBe(1111);
    expect(published[0]?.tags).toEqual([
      ['I', SUBSCLAW],
      ['K', 'web'],
      ['i', SUBSCLAW],
      ['k', 'web'],
      ['L', 'agent'],
      ['l', 'ai', 'agent'],
      ['client', 'test-client'],
    ]);
  });

  it('publishes a reply with root and parent context', async () => {
    const { tools, published, target } = harness();
    const result = await tools.reply({ event_id: target.id, content: 'reply' });
    expect(result.url).toBe(`https://clawstr.com/c/nscript/comment/${result.event_id}`);
    expect(published[0]?.tags).toContainEqual(['I', SUBSCLAW]);
    expect(published[0]?.tags).toContainEqual(['e', target.id, '', target.pubkey]);
    expect(published[0]?.tags).toContainEqual(['k', '1111']);
    expect(published[0]?.tags).toContainEqual(['p', target.pubkey]);
    expect(published[0]?.tags).toContainEqual(['l', 'ai', 'agent']);
  });

  it('publishes a vote with e, k, and p', async () => {
    const { tools, published, target } = harness();
    const result = await tools.vote({ event_id: target.id, direction: 'up' });
    expect(result.target_url).toBe(`https://clawstr.com/c/nscript/post/${target.id}`);
    expect(published[0]?.kind).toBe(7);
    expect(published[0]?.content).toBe('+');
    expect(published[0]?.tags).toEqual([
      ['e', target.id, '', target.pubkey],
      ['k', '1111'],
      ['p', target.pubkey],
      ['client', 'test-client'],
    ]);
  });

  it('merges the existing profile instead of replacing it', async () => {
    const { tools, published } = harness();
    await tools.setProfile({ display_name: 'New' });
    const content = JSON.parse(published[0]?.content ?? '{}') as Record<string, unknown>;
    expect(content.name).toBe('Old');
    expect(content.about).toBe('Old about');
    expect(content.display_name).toBe('New');
  });

  it('only allows the author to delete their event', async () => {
    const { tools, published, target } = harness();
    await tools.delete({ event_id: target.id });
    expect(published[0]?.kind).toBe(5);
    expect(published[0]?.tags).toContainEqual(['e', target.id]);

    const other = harness();
    other.target.pubkey = 'f'.repeat(64);
    await expect(other.tools.delete({ event_id: other.target.id })).rejects.toThrow(
      /not the author/,
    );
  });

  it('fails closed when writes are disabled', async () => {
    const { tools } = harness({ allowWrites: false });
    await expect(tools.post({ subclaw: 'nscript', content: 'hello' })).rejects.toThrow(
      /writes are disabled/,
    );
  });

  it('rejects duplicate content and oversized content', async () => {
    const { tools } = harness();
    await tools.post({ subclaw: 'nscript', content: 'hello' });
    await expect(tools.post({ subclaw: 'nscript', content: 'hello' })).rejects.toThrow(
      /duplicate/,
    );

    const small = harness({ maxContentBytes: 3 });
    await expect(small.tools.post({ subclaw: 'nscript', content: 'hello' })).rejects.toThrow(
      /exceeds 3 bytes/,
    );
  });
});
