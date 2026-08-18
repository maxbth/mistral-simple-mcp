import {test, expect} from 'bun:test';
// The brief's snippet imported `StreamableHTTPClientTransport` from a `/streamableHttp` subpath.
// The installed @modelcontextprotocol/client (2.0.0) exports only `.`, `./stdio`,
// `./validators/ajv`, `./validators/cf-worker` and `./_shims` (see its package.json `exports`) —
// there is no `/streamableHttp` subpath. Both symbols live on the package root, which matches how
// transports/integration.test.ts in the sibling project this transport layer was modeled on
// imports them against the same client version.
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {buildHttpApp} from './http';
import type {Config} from '../config';
import type {MistralClient} from '../mistral-client';
import {MistralError} from '../errors';

function config(): Config {
  return {
    mistral: {
      apiKey: 'sk-test-key',
      model: 'mistral-medium-latest',
      timeoutMs: 60_000,
    },
    mcp: {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      allowedOrigins: [],
    },
  };
}

async function withServer(client: MistralClient, run: (mcp: Client) => Promise<void>): Promise<void> {
  const {app, close} = buildHttpApp(config(), {client});
  const server = Bun.serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: 0,
  });
  const mcp = new Client({
    name: 'test',
    version: '0.0.0',
  });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    await run(mcp);
  } finally {
    // `catch(() => undefined)` rather than `catch(() => {})`: an empty block body trips
    // @typescript-eslint/no-empty-function, while a concise-body arrow returning `undefined`
    // does not, and disabling the rule is not an option here.
    await mcp.close().catch(() => undefined);
    await close();
    server.stop(true);
  }
}

/**
 * `noUncheckedIndexedAccess` types `content[0]` as possibly `undefined`, and
 * `@typescript-eslint/no-non-null-assertion` forbids silencing that with `!`. This asserts and
 * narrows in one call instead, so a genuinely empty array still fails loudly.
 */
function first<T>(items: Array<T>): T {
  const value = items[0];
  if (value === undefined) {
    throw new Error('expected at least one item');
  }
  return value;
}

test('lists both tools over streamable http', async () => {
  const client = {
    complete: async () => ({
      text: '',
      model: 'm',
      finishReason: 'stop',
      usage: {},
    }),
  } as unknown as MistralClient;
  await withServer(client, async (mcp) => {
    const {tools} = await mcp.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['mistral_complete', 'mistral_extract']);
  });
});

test('a successful call returns the handler payload as JSON text', async () => {
  const client = {
    complete: async () => ({
      text: 'hello',
      model: 'mistral-medium-latest',
      finishReason: 'stop',
      usage: {totalTokens: 5},
    }),
  } as unknown as MistralClient;

  await withServer(client, async (mcp) => {
    const result = await mcp.callTool({
      name: 'mistral_complete',
      arguments: {prompt: 'hi'},
    });
    const content = result.content as Array<{
      type: string;
      text: string;
    }>;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(first(content).text)).toMatchObject({
      text: 'hello',
      model: 'mistral-medium-latest',
    });
  });
});

test('a MistralError surfaces its own message as a tool error', async () => {
  const client = {
    complete: async () => {
      throw new MistralError('Mistral rate limit exceeded (HTTP 429). Wait and retry, or use a smaller model.', 429);
    },
  } as unknown as MistralClient;

  await withServer(client, async (mcp) => {
    const result = await mcp.callTool({
      name: 'mistral_complete',
      arguments: {prompt: 'hi'},
    });
    const content = result.content as Array<{
      type: string;
      text: string;
    }>;
    expect(result.isError).toBe(true);
    expect(first(content).text).toMatch(/rate limit/i);
  });
});

test('an unexpected error is replaced with a generic message', async () => {
  const client = {
    complete: async () => {
      throw new Error('ECONNREFUSED 10.0.0.5:443 apiKey=sk-test-key');
    },
  } as unknown as MistralClient;

  await withServer(client, async (mcp) => {
    const result = await mcp.callTool({
      name: 'mistral_complete',
      arguments: {prompt: 'hi'},
    });
    const content = result.content as Array<{
      type: string;
      text: string;
    }>;
    expect(result.isError).toBe(true);
    expect(first(content).text).toBe('Unexpected failure in mistral_complete.');
    expect(first(content).text).not.toContain('sk-test-key');
  });
});
