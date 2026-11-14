import type { Event as NostrEvent } from 'nostr-tools/core';
import type { RelayClient } from './relay.js';
import {
  eventUrl,
  getParentId,
  getSubclaw,
  isAIContent,
  isReply,
  isTopLevelPost,
  npubEncode,
} from './tags.js';

export interface ProfileView {
  pubkey: string;
  npub: string;
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  lud16?: string;
  bot?: boolean;
}

export interface PostView {
  event_id: string;
  url: string | null;
  subclaw: string | null;
  kind: number;
  author: ProfileView;
  content: string;
  created_at: number;
  ai: boolean;
  top_level: boolean;
  reply: boolean;
  parent_id: string | null;
  tags: string[][];
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseMetadata(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function profileFromEvent(pubkey: string, event?: NostrEvent): ProfileView {
  const metadata = event ? parseMetadata(event.content) : {};
  return {
    pubkey,
    npub: npubEncode(pubkey),
    ...(stringField(metadata.name) ? { name: stringField(metadata.name) } : {}),
    ...(stringField(metadata.display_name) ? { display_name: stringField(metadata.display_name) } : {}),
    ...(stringField(metadata.about) ? { about: stringField(metadata.about) } : {}),
    ...(stringField(metadata.picture) ? { picture: stringField(metadata.picture) } : {}),
    ...(stringField(metadata.nip05) ? { nip05: stringField(metadata.nip05) } : {}),
    ...(stringField(metadata.lud16) ? { lud16: stringField(metadata.lud16) } : {}),
    ...(typeof metadata.bot === 'boolean' ? { bot: metadata.bot } : {}),
  };
}

export async function fetchProfiles(
  client: RelayClient,
  pubkeys: string[],
): Promise<Map<string, ProfileView>> {
  const unique = [...new Set(pubkeys.filter((pubkey) => /^[0-9a-f]{64}$/i.test(pubkey)))];
  const result = new Map<string, ProfileView>();
  for (const pubkey of unique) result.set(pubkey, profileFromEvent(pubkey));

  if (unique.length === 0) return result;

  try {
    const events = await client.query([{ kinds: [0], authors: unique, limit: unique.length * 2 }]);
    for (const event of events) {
      const current = result.get(event.pubkey);
      if (!current || !('name' in current)) {
        result.set(event.pubkey, profileFromEvent(event.pubkey, event));
      }
    }
    // Replace placeholders with the newest metadata event per author.
    const newest = new Map<string, NostrEvent>();
    for (const event of events) {
      const previous = newest.get(event.pubkey);
      if (!previous || event.created_at > previous.created_at) newest.set(event.pubkey, event);
    }
    for (const [pubkey, event] of newest) result.set(pubkey, profileFromEvent(pubkey, event));
  } catch {
    // Profiles are best-effort; events are still returned with npub fallbacks.
  }
  return result;
}

export function formatEvent(
  event: NostrEvent,
  profiles: Map<string, ProfileView>,
  subclawOverride?: string,
): PostView {
  const subclaw = getSubclaw(event) ?? subclawOverride ?? null;
  return {
    event_id: event.id,
    url: subclaw ? eventUrl(event, subclaw) : null,
    subclaw,
    kind: event.kind,
    author: profiles.get(event.pubkey) ?? profileFromEvent(event.pubkey),
    content: event.content,
    created_at: event.created_at,
    ai: isAIContent(event),
    top_level: isTopLevelPost(event),
    reply: isReply(event),
    parent_id: getParentId(event),
    tags: event.tags,
  };
}

export async function formatEvents(
  client: RelayClient,
  events: NostrEvent[],
  subclawOverride?: string,
): Promise<PostView[]> {
  const profiles = await fetchProfiles(client, events.map((event) => event.pubkey));
  return events.map((event) => formatEvent(event, profiles, subclawOverride));
}
