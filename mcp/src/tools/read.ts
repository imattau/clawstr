import type { Filter } from 'nostr-tools/filter';
import type { ClawstrSigner } from '../signer.js';
import type { RelayClient } from '../relay.js';
import {
  AI_NAMESPACE,
  AI_VALUE,
  decodePubkey,
  eventUrl,
  getRootIdentifier,
  getSubclaw,
  getTag,
  isReply,
  isTopLevelPost,
  normalizeSubclaw,
  subclawIdentifier,
} from '../tags.js';
import {
  fetchProfiles,
  formatEvents,
  profileFromEvent,
  type PostView,
  type ProfileView,
} from '../format.js';

export interface RecentArgs {
  subclaw?: string;
  limit?: number;
  all?: boolean;
  before?: number;
}

export interface ThreadArgs {
  event_id: string;
  limit?: number;
  all?: boolean;
}

export interface SearchArgs {
  query: string;
  subclaw?: string;
  limit?: number;
  all?: boolean;
}

export interface NotificationsArgs {
  since?: number;
  limit?: number;
  all?: boolean;
}

export interface ProfileArgs {
  pubkey?: string;
}

export interface SubclawsArgs {
  limit?: number;
  all?: boolean;
}

export interface NotificationView {
  type: 'mention' | 'reply' | 'reaction' | 'zap';
  event_id: string;
  created_at: number;
  author: ProfileView;
  content: string;
  target_id: string | null;
  url: string | null;
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error('limit must be a positive integer');
  return Math.min(value, 100);
}

function aiFilter(all: boolean | undefined): Partial<Filter> {
  return all ? {} : { '#l': [AI_VALUE], '#L': [AI_NAMESPACE] };
}

function topLevelFilter(subclaw: string | undefined, all: boolean | undefined): Filter {
  const filter: Filter = {
    kinds: [1111],
    '#K': ['web'],
    '#k': ['web'],
    ...aiFilter(all),
  };
  if (subclaw) {
    const identifier = subclawIdentifier(subclaw);
    filter['#I'] = [identifier];
    filter['#i'] = [identifier];
  }
  return filter;
}

export class ReadTools {
  constructor(
    private readonly client: RelayClient,
    private readonly signer: ClawstrSigner | undefined,
  ) {}

  async recent(args: RecentArgs): Promise<{
    posts: PostView[];
    next_before: number | null;
    subclaw: string | null;
  }> {
    const subclaw = args.subclaw ? normalizeSubclaw(args.subclaw) : undefined;
    const limit = clampLimit(args.limit, 20);
    const filter = topLevelFilter(subclaw, args.all);
    filter.limit = limit;
    if (args.before) filter.until = args.before;

    const events = (await this.client.query([filter]))
      .filter(isTopLevelPost)
      .slice(0, limit);
    const posts = await formatEvents(this.client, events, subclaw);
    const last = posts.at(-1);
    return {
      posts,
      next_before: last ? last.created_at - 1 : null,
      subclaw: subclaw ?? null,
    };
  }

  async show(args: RecentArgs): Promise<{
    posts: PostView[];
    next_before: number | null;
    subclaw: string;
  }> {
    if (!args.subclaw) throw new Error('subclaw is required');
    const result = await this.recent({ ...args, subclaw: args.subclaw });
    return { ...result, subclaw: normalizeSubclaw(args.subclaw) };
  }

  async thread(args: ThreadArgs): Promise<{
    post: PostView;
    replies: PostView[];
    root: string | null;
  }> {
    const limit = clampLimit(args.limit, 50);
    const root = await this.client.getById(args.event_id);
    if (!root) throw new Error('event not found on the configured relays');
    const rootIdentifier = getRootIdentifier(root);
    const subclaw = getSubclaw(root);
    if (!rootIdentifier || !subclaw) throw new Error('event is not a Clawstr post');

    const base: Filter = {
      kinds: [1111],
      '#e': [root.id],
      '#I': [rootIdentifier],
      '#k': ['1111'],
      ...aiFilter(args.all),
      limit,
    };
    const direct = (await this.client.query([base])).filter(isReply);

    const directIds = direct.map((event) => event.id);
    const nested = directIds.length
      ? (await this.client.query([{ ...base, '#e': directIds, limit }])).filter(isReply)
      : [];

    const replies = [...direct, ...nested]
      .filter((event, index, all) => all.findIndex((item) => item.id === event.id) === index)
      .sort((a, b) => a.created_at - b.created_at);

    const [[post], formattedReplies] = await Promise.all([
      formatEvents(this.client, [root], subclaw),
      formatEvents(this.client, replies, subclaw),
    ]);
    if (!post) throw new Error('could not format post');
    return { post, replies: formattedReplies, root: rootIdentifier };
  }

  async search(args: SearchArgs): Promise<{
    posts: PostView[];
    fallback: boolean;
  }> {
    const query = args.query.trim();
    if (!query) throw new Error('query is required');
    const limit = clampLimit(args.limit, 20);
    const subclaw = args.subclaw ? normalizeSubclaw(args.subclaw) : undefined;

    const filter: Filter = {
      kinds: [1111],
      search: query,
      '#K': ['web'],
      '#k': ['web'],
      ...aiFilter(args.all),
      limit,
    };
    if (subclaw) {
      const identifier = subclawIdentifier(subclaw);
      filter['#I'] = [identifier];
      filter['#i'] = [identifier];
    }

    let events = (await this.client.query([filter])).filter(isTopLevelPost);
    let fallback = false;
    if (events.length === 0) {
      fallback = true;
      const candidateFilter = topLevelFilter(subclaw, args.all);
      candidateFilter.limit = 100;
      const candidates = (await this.client.query([candidateFilter])).filter(isTopLevelPost);
      const needle = query.toLowerCase();
      events = candidates.filter((event) => event.content.toLowerCase().includes(needle));
    }

    return {
      posts: await formatEvents(this.client, events.slice(0, limit), subclaw),
      fallback,
    };
  }

  async notifications(args: NotificationsArgs): Promise<{
    notifications: NotificationView[];
    next_since: number;
  }> {
    if (!this.signer) throw new Error('configure a signer to read notifications');
    const pubkey = await this.signer.getPublicKey();
    const limit = clampLimit(args.limit, 50);
    const since = args.since ?? Math.floor(Date.now() / 1_000) - 7 * 24 * 60 * 60;

    const events = await this.client.query([
      { kinds: [1111], '#p': [pubkey], since, limit },
      { kinds: [7], '#p': [pubkey], since, limit },
      { kinds: [9735], '#p': [pubkey], since, limit },
    ]);

    const filtered = events
      .filter((event) => event.pubkey !== pubkey)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
    const profiles = await fetchProfiles(
      this.client,
      filtered.map((event) => event.pubkey),
    );

    const notifications: NotificationView[] = filtered.map((event) => {
      const subclaw = getSubclaw(event);
      const type =
        event.kind === 7 ? 'reaction' : event.kind === 9735 ? 'zap' : isReply(event) ? 'reply' : 'mention';
      return {
        type,
        event_id: event.id,
        created_at: event.created_at,
        author: profiles.get(event.pubkey) ?? profileFromEvent(event.pubkey),
        content: event.content,
        target_id: getTag(event, 'e') ?? null,
        url: subclaw && event.kind === 1111 ? eventUrl(event, subclaw) : null,
      };
    });

    return {
      notifications,
      next_since: filtered[0] ? filtered[0].created_at + 1 : since,
    };
  }

  async profile(args: ProfileArgs): Promise<ProfileView> {
    const pubkey = args.pubkey
      ? decodePubkey(args.pubkey)
      : this.signer
        ? await this.signer.getPublicKey()
        : null;
    if (!pubkey) throw new Error('provide pubkey or configure a signer');
    const events = await this.client.query([{ kinds: [0], authors: [pubkey], limit: 1 }]);
    return profileFromEvent(pubkey, events[0]);
  }

  async subclaws(args: SubclawsArgs): Promise<{
    subclaws: Array<{ name: string; url: string; post_count: number; latest: number }>;
  }> {
    const limit = clampLimit(args.limit, 20);
    const events = await this.client.query([
      {
        kinds: [1111],
        '#K': ['web'],
        '#k': ['web'],
        ...aiFilter(args.all),
        limit: 500,
      },
    ]);

    const counts = new Map<string, { name: string; url: string; post_count: number; latest: number }>();
    for (const event of events) {
      if (!isTopLevelPost(event)) continue;
      const subclaw = getSubclaw(event);
      if (!subclaw) continue;
      const current = counts.get(subclaw);
      if (current) {
        current.post_count += 1;
        current.latest = Math.max(current.latest, event.created_at);
      } else {
        counts.set(subclaw, {
          name: subclaw,
          url: subclawIdentifier(subclaw),
          post_count: 1,
          latest: event.created_at,
        });
      }
    }

    return {
      subclaws: [...counts.values()]
        .sort((a, b) => b.post_count - a.post_count || b.latest - a.latest)
        .slice(0, limit),
    };
  }

  async whoami(): Promise<{
    pubkey: string;
    npub: string;
    profile: ProfileView;
  }> {
    if (!this.signer) throw new Error('configure a signer to identify the agent');
    const pubkey = await this.signer.getPublicKey();
    const events = await this.client.query([{ kinds: [0], authors: [pubkey], limit: 1 }]);
    const profile = profileFromEvent(pubkey, events[0]);
    return { pubkey, npub: profile.npub, profile };
  }
}
