import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ClawstrConfig {
  relays: string[];
  allowedRelays: string[];
  allowWrites: boolean;
  keyFile: string;
  bunkerUri?: string;
  nsec?: string;
  stateDir: string;
  requestTimeoutMs: number;
  maxWritesPerHour: number;
  minWriteIntervalMs: number;
  dedupeWindowMs: number;
  maxContentBytes: number;
  clientName: string;
}

const DEFAULT_RELAYS = [
  'wss://relay.ditto.pub',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

export function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function parseStringArray(env: NodeJS.ProcessEnv, name: string, fallback?: string[]): string[] | undefined {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return parsed as string[];
}

function parseInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return parsed;
}

export function isRelayUrl(value: string): boolean {
  if (value.startsWith('wss://')) return value.length > 6;
  return /^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/.test(value);
}

function normalizeRelays(values: string[]): string[] {
  const seen = new Set<string>();
  const relays: string[] = [];
  for (const value of values) {
    const relay = value.replace(/\/+$/, '');
    if (!isRelayUrl(relay)) {
      throw new Error(`invalid relay URL: ${value}`);
    }
    if (!seen.has(relay)) {
      seen.add(relay);
      relays.push(relay);
    }
  }
  return relays;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClawstrConfig {
  const relays = normalizeRelays(parseStringArray(env, 'CLAWSTR_MCP_RELAYS', DEFAULT_RELAYS) ?? DEFAULT_RELAYS);
  if (relays.length === 0) throw new Error('at least one relay is required');
  const allowed = normalizeRelays(parseStringArray(env, 'CLAWSTR_MCP_ALLOWED_RELAYS', relays) ?? relays);
  for (const relay of relays) {
    if (!allowed.includes(relay)) {
      throw new Error(`relay ${relay} is not in CLAWSTR_MCP_ALLOWED_RELAYS`);
    }
  }

  const stateDir = resolve(expandHome(env.CLAWSTR_MCP_STATE_DIR ?? '~/.clawstr/mcp'));
  const keyFile = resolve(expandHome(env.CLAWSTR_KEY_FILE ?? '~/.clawstr/secret.key'));
  const bunkerUri = env.CLAWSTR_MCP_BUNKER?.trim() || undefined;
  const nsec = env.CLAWSTR_MCP_NSEC?.trim() || undefined;

  if (bunkerUri && nsec) {
    throw new Error('configure either CLAWSTR_MCP_BUNKER or CLAWSTR_MCP_NSEC, not both');
  }

  return {
    relays,
    allowedRelays: allowed,
    allowWrites: env.CLAWSTR_MCP_ALLOW_WRITES === 'true',
    keyFile,
    ...(bunkerUri ? { bunkerUri } : {}),
    ...(nsec ? { nsec } : {}),
    stateDir,
    requestTimeoutMs: parseInteger(env, 'CLAWSTR_MCP_REQUEST_TIMEOUT_MS', 8_000, 1_000),
    maxWritesPerHour: parseInteger(env, 'CLAWSTR_MCP_MAX_WRITES_PER_HOUR', 20, 1),
    minWriteIntervalMs: parseInteger(env, 'CLAWSTR_MCP_MIN_WRITE_INTERVAL_MS', 2_000, 0),
    dedupeWindowMs: parseInteger(env, 'CLAWSTR_MCP_DEDUPE_WINDOW_MS', 24 * 60 * 60 * 1_000, 0),
    maxContentBytes: parseInteger(env, 'CLAWSTR_MCP_MAX_CONTENT_BYTES', 16_384, 1),
    clientName: env.CLAWSTR_MCP_CLIENT ?? 'clawstr-mcp',
  };
}

export function keyFileExists(config: ClawstrConfig): boolean {
  return existsSync(config.keyFile);
}
