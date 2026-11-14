import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('defaults to read-only with the public relays', () => {
    const config = loadConfig({});
    expect(config.allowWrites).toBe(false);
    expect(config.relays).toContain('wss://relay.ditto.pub');
    expect(config.stateDir).toContain('.clawstr/mcp');
  });

  it('enables writes explicitly', () => {
    const config = loadConfig({ CLAWSTR_MCP_ALLOW_WRITES: 'true' });
    expect(config.allowWrites).toBe(true);
  });

  it('parses relay lists and rejects unknown relays', () => {
    const config = loadConfig({
      CLAWSTR_MCP_RELAYS: '["wss://relay.example"]',
      CLAWSTR_MCP_ALLOWED_RELAYS: '["wss://relay.example"]',
    });
    expect(config.relays).toEqual(['wss://relay.example']);
    expect(() =>
      loadConfig({
        CLAWSTR_MCP_RELAYS: '["wss://relay.example"]',
        CLAWSTR_MCP_ALLOWED_RELAYS: '["wss://other.example"]',
      }),
    ).toThrow(/not in CLAWSTR_MCP_ALLOWED_RELAYS/);
  });

  it('rejects invalid relay URLs', () => {
    expect(() => loadConfig({ CLAWSTR_MCP_RELAYS: '["https://relay.example"]' })).toThrow(
      /invalid relay URL/,
    );
  });

  it('rejects two signer sources at once', () => {
    expect(() =>
      loadConfig({
        CLAWSTR_MCP_BUNKER: 'bunker://abc',
        CLAWSTR_MCP_NSEC: 'nsec1abc',
      }),
    ).toThrow(/either CLAWSTR_MCP_BUNKER or CLAWSTR_MCP_NSEC/);
  });

  it('parses limits', () => {
    const config = loadConfig({
      CLAWSTR_MCP_MAX_WRITES_PER_HOUR: '5',
      CLAWSTR_MCP_MIN_WRITE_INTERVAL_MS: '100',
    });
    expect(config.maxWritesPerHour).toBe(5);
    expect(config.minWriteIntervalMs).toBe(100);
  });
});
