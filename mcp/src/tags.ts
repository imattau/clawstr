import type { Event as NostrEvent } from 'nostr-tools/core';
import { decode, npubEncode as nip19NpubEncode } from 'nostr-tools/nip19';

export const CLAWSTR_BASE = 'https://clawstr.com';
export const AI_NAMESPACE = 'agent';
export const AI_VALUE = 'ai';

const SUBCLAW_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizeSubclaw(input: string): string {
  let value = input.trim();
  if (value.startsWith(`${CLAWSTR_BASE}/c/`)) value = value.slice(`${CLAWSTR_BASE}/c/`.length);
  else if (value.startsWith('/c/')) value = value.slice(3);
  else if (value.startsWith('c/')) value = value.slice(2);
  value = value.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!SUBCLAW_PATTERN.test(value)) {
    throw new Error(
      'subclaw must be a name like /c/nostr, nostr, or https://clawstr.com/c/nostr',
    );
  }
  return value;
}

export function subclawIdentifier(name: string): string {
  return `${CLAWSTR_BASE}/c/${normalizeSubclaw(name)}`;
}

export function parseSubclawIdentifier(value: string): string | null {
  if (!value.startsWith(`${CLAWSTR_BASE}/c/`)) return null;
  const name = value.slice(`${CLAWSTR_BASE}/c/`.length).replace(/\/+$/, '');
  return SUBCLAW_PATTERN.test(name) ? name : null;
}

export function getTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

export function getTags(event: NostrEvent, name: string): string[] {
  return event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1] ?? '');
}

export function getSubclaw(event: NostrEvent): string | null {
  const identifier = getTag(event, 'I');
  return identifier ? parseSubclawIdentifier(identifier) : null;
}

export function isTopLevelPost(event: NostrEvent): boolean {
  if (!getSubclaw(event)) return false;
  return (
    getTag(event, 'I') === getTag(event, 'i') &&
    getTag(event, 'K') === 'web' &&
    getTag(event, 'k') === 'web'
  );
}

export function isReply(event: NostrEvent): boolean {
  if (!getSubclaw(event)) return false;
  return getTag(event, 'k') === '1111' && Boolean(getTag(event, 'e'));
}

export function getRootIdentifier(event: NostrEvent): string | null {
  return getTag(event, 'I') ?? null;
}

export function getParentId(event: NostrEvent): string | null {
  return getTag(event, 'e') ?? null;
}

export function isAIContent(event: NostrEvent): boolean {
  return (
    event.tags.some(([name, value]) => name === 'L' && value === AI_NAMESPACE) &&
    event.tags.some(
      ([name, value, namespace]) => name === 'l' && value === AI_VALUE && namespace === AI_NAMESPACE,
    )
  );
}

export function agentLabelTags(): string[][] {
  return [
    ['L', AI_NAMESPACE],
    ['l', AI_VALUE, AI_NAMESPACE],
  ];
}

export function postTags(subclaw: string, client = 'clawstr-mcp'): string[][] {
  const identifier = subclawIdentifier(subclaw);
  return [
    ['I', identifier],
    ['K', 'web'],
    ['i', identifier],
    ['k', 'web'],
    ...agentLabelTags(),
    ['client', client],
  ];
}

export function replyTags(parent: NostrEvent, client = 'clawstr-mcp'): string[][] {
  const root = getRootIdentifier(parent);
  if (!root) throw new Error('target is not a Clawstr post (missing I tag)');
  if (!parseSubclawIdentifier(root)) throw new Error('target is not a Clawstr subclaw post');
  return [
    ['I', root],
    ['K', 'web'],
    ['e', parent.id, '', parent.pubkey],
    ['k', '1111'],
    ['p', parent.pubkey],
    ...agentLabelTags(),
    ['client', client],
  ];
}

export function voteTags(target: NostrEvent, client = 'clawstr-mcp'): string[][] {
  if (!getSubclaw(target)) throw new Error('target is not a Clawstr event');
  return [
    ['e', target.id, '', target.pubkey],
    ['k', String(target.kind)],
    ['p', target.pubkey],
    ['client', client],
  ];
}

export function deletionTags(target: NostrEvent, client = 'clawstr-mcp'): string[][] {
  return [
    ['e', target.id],
    ['k', String(target.kind)],
    ['client', client],
  ];
}

export function channelUrl(subclaw: string): string {
  return subclawIdentifier(subclaw);
}

export function eventUrl(event: NostrEvent, subclaw: string): string {
  const suffix = isTopLevelPost(event) ? 'post' : 'comment';
  return `${subclawIdentifier(subclaw)}/${suffix}/${event.id}`;
}

export function decodeEventId(input: string): string {
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = decode(value);
    if (decoded.type === 'note') return decoded.data;
    if (decoded.type === 'nevent') return decoded.data.id;
  } catch {
    // fall through
  }
  throw new Error('event_id must be a hex event id, note1, or nevent1');
}

export function decodePubkey(input: string): string {
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = decode(value);
    if (decoded.type === 'npub') return decoded.data;
    if (decoded.type === 'nprofile') return decoded.data.pubkey;
  } catch {
    // fall through
  }
  throw new Error('pubkey must be a hex pubkey, npub, or nprofile');
}

export function npubEncode(pubkey: string): string {
  return nip19NpubEncode(pubkey);
}

export function contentBytes(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}
