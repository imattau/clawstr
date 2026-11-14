import { createHash } from 'node:crypto';
import type { Event as NostrEvent, EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import type { ClawstrConfig } from '../config.js';
import type { RelayClient, RelayOutcome } from '../relay.js';
import type { ClawstrSigner } from '../signer.js';
import type { WriteGate } from '../state.js';
import { parseMetadata } from '../format.js';
import {
  contentBytes,
  decodeEventId,
  deletionTags,
  eventUrl,
  getSubclaw,
  normalizeSubclaw,
  postTags,
  replyTags,
  voteTags,
} from '../tags.js';

export interface PostArgs {
  subclaw: string;
  content: string;
}

export interface ReplyArgs {
  event_id: string;
  content: string;
}

export interface VoteArgs {
  event_id: string;
  direction: 'up' | 'down';
}

export interface SetProfileArgs {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud06?: string;
  lud16?: string;
  bot?: boolean;
}

export interface DeleteArgs {
  event_id: string;
}

export interface WriteResult {
  event_id: string;
  url: string | null;
  target_url?: string;
  relays: RelayOutcome[];
  duplicate: boolean;
  note?: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class WriteTools {
  constructor(
    private readonly client: RelayClient,
    private readonly signer: ClawstrSigner | undefined,
    private readonly gate: WriteGate,
    private readonly config: ClawstrConfig,
  ) {}

  private ready(): ClawstrSigner {
    if (!this.config.allowWrites) {
      throw new Error('writes are disabled; set CLAWSTR_MCP_ALLOW_WRITES=true');
    }
    if (!this.signer) {
      throw new Error(
        'no signer configured; set CLAWSTR_MCP_BUNKER, CLAWSTR_MCP_NSEC, or ~/.clawstr/secret.key',
      );
    }
    return this.signer;
  }

  private validateContent(content: string): string {
    const value = content.trim();
    if (!value) throw new Error('content is required');
    if (contentBytes(value) > this.config.maxContentBytes) {
      throw new Error(`content exceeds ${this.config.maxContentBytes} bytes`);
    }
    return value;
  }

  private async publish(
    tool: string,
    template: EventTemplate,
    dedupeKey: string,
    target?: string,
  ): Promise<{ event: VerifiedEvent; relays: RelayOutcome[] }> {
    const signer = this.ready();
    return this.gate.runExclusive(async () => {
      this.gate.check(dedupeKey);
      try {
        const event = await signer.signEvent(template);
        const relays = await this.client.publish(event);
        this.gate.record(dedupeKey);
        this.gate.audit({ tool, event_id: event.id, ...(target ? { target } : {}) });
        return { event, relays };
      } catch (error) {
        this.gate.audit({
          tool,
          ...(target ? { target } : {}),
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  async post(args: PostArgs): Promise<WriteResult> {
    const signer = this.ready();
    const subclaw = normalizeSubclaw(args.subclaw);
    const content = this.validateContent(args.content);
    const pubkey = await signer.getPublicKey();
    const template: EventTemplate = {
      kind: 1111,
      created_at: Math.floor(Date.now() / 1_000),
      tags: postTags(subclaw, this.config.clientName),
      content,
    };
    const { event, relays } = await this.publish(
      'clawstr_post',
      template,
      `post:${pubkey}:${subclaw}:${hash(content)}`,
      subclaw,
    );
    return { event_id: event.id, url: eventUrl(event, subclaw), relays, duplicate: false };
  }

  async reply(args: ReplyArgs): Promise<WriteResult> {
    const signer = this.ready();
    const targetId = decodeEventId(args.event_id);
    const content = this.validateContent(args.content);
    const target = await this.getTarget(targetId);
    const subclaw = getSubclaw(target);
    if (!subclaw) throw new Error('target is not a Clawstr event');
    const pubkey = await signer.getPublicKey();
    const template: EventTemplate = {
      kind: 1111,
      created_at: Math.floor(Date.now() / 1_000),
      tags: replyTags(target, this.config.clientName),
      content,
    };
    const { event, relays } = await this.publish(
      'clawstr_reply',
      template,
      `reply:${pubkey}:${target.id}:${hash(content)}`,
      target.id,
    );
    return { event_id: event.id, url: eventUrl(event, subclaw), relays, duplicate: false };
  }

  async vote(args: VoteArgs): Promise<WriteResult> {
    const signer = this.ready();
    const targetId = decodeEventId(args.event_id);
    const target = await this.getTarget(targetId);
    const subclaw = getSubclaw(target);
    if (!subclaw) throw new Error('target is not a Clawstr event');
    const pubkey = await signer.getPublicKey();
    const content = args.direction === 'up' ? '+' : '-';
    const template: EventTemplate = {
      kind: 7,
      created_at: Math.floor(Date.now() / 1_000),
      tags: voteTags(target, this.config.clientName),
      content,
    };
    const { event, relays } = await this.publish(
      'clawstr_vote',
      template,
      `vote:${pubkey}:${target.id}`,
      target.id,
    );
    return {
      event_id: event.id,
      url: null,
      target_url: eventUrl(target, subclaw),
      relays,
      duplicate: false,
    };
  }

  async setProfile(args: SetProfileArgs): Promise<WriteResult> {
    const signer = this.ready();
    const pubkey = await signer.getPublicKey();
    const existing = (await this.client.query([{ kinds: [0], authors: [pubkey], limit: 1 }]))[0];
    const merged: Record<string, unknown> = existing ? parseMetadata(existing.content) : {};
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && value !== '') merged[key] = value;
    }
    if (Object.keys(merged).length === 0) throw new Error('provide at least one profile field');
    const content = JSON.stringify(merged);
    const template: EventTemplate = {
      kind: 0,
      created_at: Math.floor(Date.now() / 1_000),
      tags: [],
      content,
    };
    const { event, relays } = await this.publish(
      'clawstr_set_profile',
      template,
      `profile:${pubkey}:${hash(content)}`,
      pubkey,
    );
    return { event_id: event.id, url: null, relays, duplicate: false };
  }

  async delete(args: DeleteArgs): Promise<WriteResult> {
    const signer = this.ready();
    const targetId = decodeEventId(args.event_id);
    const target = await this.getTarget(targetId);
    const subclaw = getSubclaw(target);
    if (!subclaw) throw new Error('target is not a Clawstr event');
    const pubkey = await signer.getPublicKey();
    if (target.pubkey !== pubkey) {
      throw new Error('the configured signer is not the author of the target event');
    }
    const template: EventTemplate = {
      kind: 5,
      created_at: Math.floor(Date.now() / 1_000),
      tags: deletionTags(target, this.config.clientName),
      content: '',
    };
    const { event, relays } = await this.publish(
      'clawstr_delete',
      template,
      `delete:${pubkey}:${target.id}`,
      target.id,
    );
    return {
      event_id: event.id,
      url: null,
      target_url: eventUrl(target, subclaw),
      relays,
      duplicate: false,
      note: 'Deletion is a request; relays and clients may keep the original event.',
    };
  }

  private async getTarget(id: string): Promise<NostrEvent> {
    if (!/^[0-9a-f]{64}$/i.test(id)) throw new Error('invalid event id');
    const target = await this.client.getById(id);
    if (!target) throw new Error('target event not found on the configured relays');
    return target;
  }
}
