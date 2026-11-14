import WebSocket from 'ws';
import type { Event as NostrEvent, VerifiedEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { SimplePool, useWebSocketImplementation as setWebSocketImplementation } from 'nostr-tools/pool';
import { verifyEvent } from 'nostr-tools/pure';

setWebSocketImplementation(WebSocket as unknown as typeof globalThis.WebSocket);

export interface RelayOutcome {
  url: string;
  accepted: boolean;
  detail?: string;
}

export class RelayClient {
  private readonly pool = new SimplePool();

  constructor(
    private readonly relays: string[],
    private readonly timeoutMs: number,
  ) {}

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    const settled = await Promise.allSettled(
      filters.map((filter) =>
        this.pool.querySync(this.relays, filter, { maxWait: this.timeoutMs }),
      ),
    );

    const events = new Map<string, NostrEvent>();
    let failures = 0;
    for (const result of settled) {
      if (result.status === 'rejected') {
        failures += 1;
        continue;
      }
      for (const event of result.value) {
        if (!verifyEvent(event)) continue;
        events.set(event.id, event);
      }
    }

    if (failures === filters.length) {
      const reason = settled.find((result) => result.status === 'rejected');
      throw new Error(
        reason && reason.status === 'rejected'
          ? `relay query failed: ${String(reason.reason)}`
          : 'relay query failed',
      );
    }

    return [...events.values()].sort((a, b) => b.created_at - a.created_at);
  }

  async getById(id: string): Promise<NostrEvent | null> {
    const events = await this.query([{ ids: [id], limit: 1 }]);
    return events.find((event) => event.id === id) ?? null;
  }

  async publish(event: VerifiedEvent): Promise<RelayOutcome[]> {
    const results = await Promise.allSettled(this.pool.publish(this.relays, event));
    const outcomes: RelayOutcome[] = results.map((result, index) => {
      const url = this.relays[index] ?? 'unknown';
      return result.status === 'fulfilled'
        ? { url, accepted: true }
        : { url, accepted: false, detail: String(result.reason) };
    });

    if (!outcomes.some((outcome) => outcome.accepted)) {
      const details = outcomes.map((outcome) => `${outcome.url}: ${outcome.detail ?? 'rejected'}`).join('; ');
      throw new Error(`no relay accepted the event (${details})`);
    }

    return outcomes;
  }

  close(): void {
    this.pool.destroy();
  }
}
