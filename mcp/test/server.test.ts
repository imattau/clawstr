import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'dist', 'index.js');

async function withServer<T>(fn: (rpc: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      CLAWSTR_MCP_RELAYS: '["wss://relay.example"]',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const pending = new Map<number, (value: unknown) => void>();
  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === 'number') {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
      }
      index = buffer.indexOf('\n');
    }
  });

  let nextId = 0;
  const rpc = (method: string, params?: unknown): Promise<unknown> => {
    const id = ++nextId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  try {
    return await fn(rpc);
  } finally {
    child.kill('SIGTERM');
  }
}

describe('MCP server', () => {
  it('initializes, lists tools, and gates writes', async () => {
    await withServer(async (rpc) => {
      const initialized = (await rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })) as { result?: { serverInfo?: { name?: string } } };
      expect(initialized.result?.serverInfo?.name).toBe('clawstr');

      const listed = (await rpc('tools/list', {})) as {
        result?: { tools?: Array<{ name: string }> };
      };
      const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
      expect(names).toContain('clawstr_recent');
      expect(names).toContain('clawstr_post');
      expect(names).toContain('clawstr_vote');
      expect(names).toContain('clawstr_delete');
      expect(names).toHaveLength(13);

      const post = (await rpc('tools/call', {
        name: 'clawstr_post',
        arguments: { subclaw: 'nscript', content: 'hello' },
      })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(post.result?.isError).toBe(true);
      expect(post.result?.content?.[0]?.text).toContain('writes are disabled');

      const whoami = (await rpc('tools/call', {
        name: 'clawstr_whoami',
        arguments: {},
      })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(whoami.result?.isError).toBe(true);
      expect(whoami.result?.content?.[0]?.text).toContain('configure a signer');
    });
  });
});
