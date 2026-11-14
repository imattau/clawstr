import { readFileSync, existsSync } from 'node:fs';
import WebSocket from 'ws';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';
import { SimplePool, useWebSocketImplementation as setWebSocketImplementation } from 'nostr-tools/pool';
import type { ClawstrConfig } from './config.js';

setWebSocketImplementation(WebSocket as unknown as typeof globalThis.WebSocket);

export interface ClawstrSigner {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<VerifiedEvent>;
  close(): Promise<void>;
}

function decodeSecret(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, 'hex'));
  }
  if (trimmed.startsWith('nsec1')) {
    const decoded = decode(trimmed);
    if (decoded.type !== 'nsec') throw new Error('invalid nsec');
    return decoded.data;
  }
  throw new Error('secret must be 64 hex characters or nsec1…');
}

class LocalSigner implements ClawstrSigner {
  constructor(private readonly secretKey: Uint8Array) {}

  async getPublicKey(): Promise<string> {
    return getPublicKey(this.secretKey);
  }

  async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    return finalizeEvent(template, this.secretKey);
  }

  async close(): Promise<void> {}
}

class Nip46Signer implements ClawstrSigner {
  private constructor(
    private readonly signer: BunkerSigner,
    private readonly pool: SimplePool,
  ) {}

  static async connect(uri: string): Promise<Nip46Signer> {
    const pointer = await parseBunkerInput(uri);
    if (!pointer) throw new Error('invalid bunker URI');
    const pool = new SimplePool();
    const clientKey = generateSecretKey();
    const signer = BunkerSigner.fromBunker(clientKey, pointer, {
      pool,
      timeout: 60_000,
      onauth: (url) => {
        process.stderr.write(`clawstr-mcp: NIP-46 auth required: ${url}\n`);
      },
    });
    try {
      await signer.connect({ name: 'clawstr-mcp' });
    } catch (error) {
      await signer.close().catch(() => {});
      pool.destroy();
      throw error;
    }
    return new Nip46Signer(signer, pool);
  }

  async getPublicKey(): Promise<string> {
    return this.signer.getPublicKey();
  }

  async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    return this.signer.signEvent(template);
  }

  async close(): Promise<void> {
    await this.signer.close().catch(() => {});
    this.pool.destroy();
  }
}

export async function loadSigner(
  config: Pick<ClawstrConfig, 'bunkerUri' | 'nsec' | 'keyFile'>,
): Promise<ClawstrSigner | undefined> {
  if (config.bunkerUri) {
    return Nip46Signer.connect(config.bunkerUri);
  }
  if (config.nsec) {
    return new LocalSigner(decodeSecret(config.nsec));
  }
  if (existsSync(config.keyFile)) {
    return new LocalSigner(decodeSecret(readFileSync(config.keyFile, 'utf8')));
  }
  return undefined;
}
