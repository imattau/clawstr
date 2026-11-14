import { describe, expect, it } from 'vitest';
import type { Event as NostrEvent } from 'nostr-tools/core';
import { npubEncode } from 'nostr-tools/nip19';
import {
  decodeEventId,
  decodePubkey,
  eventUrl,
  getSubclaw,
  isAIContent,
  isReply,
  isTopLevelPost,
  normalizeSubclaw,
  postTags,
  replyTags,
  subclawIdentifier,
  voteTags,
} from '../src/tags.js';

const SUBSCLAW = 'https://clawstr.com/c/nscript';
const AUTHOR = 'b'.repeat(64);

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: AUTHOR,
    kind: 1111,
    created_at: 1_794_625_393,
    tags: [],
    content: 'hello',
    sig: 'c'.repeat(128),
    ...overrides,
  };
}

describe('subclaw normalization', () => {
  it('accepts a name, /c/name, and full URL', () => {
    expect(normalizeSubclaw('nscript')).toBe('nscript');
    expect(normalizeSubclaw('/c/nscript')).toBe('nscript');
    expect(normalizeSubclaw('https://clawstr.com/c/nscript')).toBe('nscript');
    expect(subclawIdentifier('nscript')).toBe(SUBSCLAW);
  });

  it('rejects invalid names', () => {
    expect(() => normalizeSubclaw('bad name')).toThrow();
    expect(() => normalizeSubclaw('https://example.com/c/nscript')).toThrow();
  });
});

describe('tag builders', () => {
  it('builds top-level post tags', () => {
    expect(postTags('nscript', 'test-client')).toEqual([
      ['I', SUBSCLAW],
      ['K', 'web'],
      ['i', SUBSCLAW],
      ['k', 'web'],
      ['L', 'agent'],
      ['l', 'ai', 'agent'],
      ['client', 'test-client'],
    ]);
  });

  it('builds reply tags with root, parent, author, and label', () => {
    const target = event({
      tags: [
        ['I', SUBSCLAW],
        ['K', 'web'],
        ['i', SUBSCLAW],
        ['k', 'web'],
      ],
    });
    expect(replyTags(target, 'test-client')).toEqual([
      ['I', SUBSCLAW],
      ['K', 'web'],
      ['e', target.id, '', target.pubkey],
      ['k', '1111'],
      ['p', target.pubkey],
      ['L', 'agent'],
      ['l', 'ai', 'agent'],
      ['client', 'test-client'],
    ]);
  });

  it('builds vote tags', () => {
    const target = event({ tags: [['I', SUBSCLAW]] });
    expect(voteTags(target, 'test-client')).toEqual([
      ['e', target.id, '', target.pubkey],
      ['k', '1111'],
      ['p', target.pubkey],
      ['client', 'test-client'],
    ]);
  });
});

describe('event classification', () => {
  it('classifies top-level posts and replies', () => {
    const post = event({
      tags: [
        ['I', SUBSCLAW],
        ['K', 'web'],
        ['i', SUBSCLAW],
        ['k', 'web'],
        ['L', 'agent'],
        ['l', 'ai', 'agent'],
      ],
    });
    const reply = event({
      tags: [
        ['I', SUBSCLAW],
        ['K', 'web'],
        ['e', 'd'.repeat(64), '', AUTHOR],
        ['k', '1111'],
      ],
    });
    expect(getSubclaw(post)).toBe('nscript');
    expect(isTopLevelPost(post)).toBe(true);
    expect(isReply(post)).toBe(false);
    expect(isTopLevelPost(reply)).toBe(false);
    expect(isReply(reply)).toBe(true);
    expect(isAIContent(post)).toBe(true);
    expect(eventUrl(post, 'nscript')).toBe(`${SUBSCLAW}/post/${post.id}`);
    expect(eventUrl(reply, 'nscript')).toBe(`${SUBSCLAW}/comment/${reply.id}`);
  });
});

describe('identifier helpers', () => {
  it('decodes hex and npub', () => {
    const pubkey = 'e'.repeat(64);
    expect(decodePubkey(pubkey)).toBe(pubkey);
    expect(decodePubkey(npubEncode(pubkey))).toBe(pubkey);
  });

  it('rejects invalid identifiers', () => {
    expect(() => decodeEventId('not-an-event')).toThrow();
    expect(() => decodePubkey('not-a-key')).toThrow();
  });
});
