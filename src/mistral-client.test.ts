import {test, expect} from 'bun:test';
import {MistralClient} from './mistral-client';
import {MistralError} from './errors';
import type {MistralConfig} from './config';
import * as sdkErrors from '@mistralai/mistralai/models/errors';

/** The shape `MistralClient` sends to `mistral.chat.complete`, captured for inspection below. */
type SeenRequest = Record<string, unknown>;

const config: MistralConfig = {
  apiKey: 'sk-test-key',
  model: 'mistral-medium-latest',
  timeoutMs: 60_000,
};

function clientWith(complete: (request: unknown) => Promise<unknown>, configOverrides: Partial<MistralConfig> = {}): MistralClient {
  const client = new MistralClient({
    ...config,
    ...configOverrides,
  });
  (client as unknown as {mistral: {chat: {complete: unknown}}}).mistral = {chat: {complete}};
  return client;
}

/**
 * Builds a real SDK HTTP error. The constructor takes `(message, {response, request, body})` —
 * not `(message, response, body)` — and derives `statusCode` from `response.status`.
 */
function sdkHttpError(status: number): sdkErrors.SDKError {
  return new sdkErrors.SDKError('request failed', {
    response: new Response('', {status}),
    request: new Request('https://api.mistral.ai/v1/chat/completions'),
    body: '',
  });
}

/**
 * Runs a real `complete()` against a local server, through the real SDK — no stubbed
 * `mistral.chat.complete`, no hand-built SDK error.
 *
 * This is the only way to cover the retry layer. Injecting an `SDKError(429)` straight into the
 * mapping function proves the mapping compiles, not that a 429 from a server ever reaches it: the
 * SDK retries a 429 internally and only surfaces the response once its own retry budget is spent,
 * so whether that budget fits inside the request deadline decides whether those branches are live
 * code or dead code. A short `timeoutMs` keeps it quick — every retry number is derived from it,
 * so the whole sequence scales down together.
 *
 * `baseUrl` is the field `MISTRAL_BASE_URL` feeds; `config.ts` is the only module allowed to read
 * the environment, so pointing the config at the fake server is how a test spells that.
 */
async function errorFromServer(respond: (request: Request) => Response, overrides: Partial<MistralConfig> = {}): Promise<MistralError> {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: respond,
  });
  try {
    const client = new MistralClient({
      ...config,
      timeoutMs: 1_000,
      baseUrl: `http://127.0.0.1:${server.port}`,
      ...overrides,
    });
    await client.complete({prompt: 'p'});
    throw new Error('expected complete to throw');
  } catch (error) {
    if (!(error instanceof MistralError)) {
      throw error;
    }
    return error;
  } finally {
    server.stop(true);
  }
}

/** Binds a port, notes it, and gives it straight back — so nothing is listening on it. */
async function closedPort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('unused'),
  });
  const {port} = server;
  await server.stop(true);
  if (port === undefined) {
    throw new Error('Bun.serve reported no port');
  }
  return port;
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

function okResponse(text: string) {
  return {
    model: 'mistral-medium-latest',
    usage: {
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    },
    choices: [
      {
        index: 0,
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: text,
        },
      },
    ],
  };
}

test('sends the prompt as a user message and returns the text', async () => {
  let seen!: SeenRequest;
  const client = clientWith(async (request) => {
    seen = request as SeenRequest;
    return okResponse('hi there');
  });

  const result = await client.complete({prompt: 'say hi'});

  expect(seen.messages).toEqual([
    {
      role: 'user',
      content: 'say hi',
    },
  ]);
  expect(result.text).toBe('hi there');
  expect(result.model).toBe('mistral-medium-latest');
  expect(result.finishReason).toBe('stop');
  expect(result.usage.totalTokens).toBe(14);
});

test('prepends a system message only when one is given', async () => {
  let seen!: SeenRequest;
  const client = clientWith(async (request) => {
    seen = request as SeenRequest;
    return okResponse('ok');
  });

  await client.complete({
    prompt: 'p',
    system: 'be terse',
  });
  expect(seen.messages).toEqual([
    {
      role: 'system',
      content: 'be terse',
    },
    {
      role: 'user',
      content: 'p',
    },
  ]);
});

test('falls back to the configured model when none is given', async () => {
  let seen!: SeenRequest;
  const client = clientWith(async (request) => {
    seen = request as SeenRequest;
    return okResponse('ok');
  });

  await client.complete({prompt: 'p'});
  expect(seen.model).toBe('mistral-medium-latest');
});

test('an explicit model overrides the configured default', async () => {
  let seen!: SeenRequest;
  const client = clientWith(async (request) => {
    seen = request as SeenRequest;
    return okResponse('ok');
  });

  await client.complete({
    prompt: 'p',
    model: 'mistral-large-latest',
  });
  expect(seen.model).toBe('mistral-large-latest');
});

test('omits optional sampling fields entirely when unset', async () => {
  let seen!: SeenRequest;
  const client = clientWith(async (request) => {
    seen = request as SeenRequest;
    return okResponse('ok');
  });

  await client.complete({prompt: 'p'});
  expect('temperature' in seen).toBe(false);
  expect('maxTokens' in seen).toBe(false);
  expect('responseFormat' in seen).toBe(false);
});

test('passes temperature, maxTokens and responseFormat through when set', async () => {
  let seen!: SeenRequest;
  const client = clientWith(async (request) => {
    seen = request as SeenRequest;
    return okResponse('{}');
  });

  const responseFormat = {
    type: 'json_schema' as const,
    jsonSchema: {
      name: 'x',
      schemaDefinition: {type: 'object'},
    },
  };
  await client.complete({
    prompt: 'p',
    temperature: 0.2,
    maxTokens: 100,
    responseFormat,
  });

  expect(seen.temperature).toBe(0.2);
  expect(seen.maxTokens).toBe(100);
  expect(seen.responseFormat).toEqual(responseFormat);
});

test('errors when the response carries no choices', async () => {
  const client = clientWith(async () => ({
    model: 'm',
    usage: {},
    choices: [],
  }));
  await expect(client.complete({prompt: 'p'})).rejects.toBeInstanceOf(MistralError);
});

test('errors when the response carries no text content', async () => {
  const client = clientWith(async () => ({
    model: 'm',
    usage: {},
    choices: [
      {
        index: 0,
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: null,
        },
      },
    ],
  }));
  await expect(client.complete({prompt: 'p'})).rejects.toBeInstanceOf(MistralError);
});

test('maps a connection failure to actionable guidance', async () => {
  const client = clientWith(async () => {
    throw new sdkErrors.ConnectionError('socket hang up', {cause: new Error('socket hang up')});
  });
  await expect(client.complete({prompt: 'p'})).rejects.toThrow(/reach the Mistral API/i);
});

test('strips credentials embedded in the base URL from a connection-failure message', async () => {
  const client = clientWith(
    async () => {
      throw new sdkErrors.ConnectionError('socket hang up', {cause: new Error('socket hang up')});
    },
    {baseUrl: 'https://user:sk-secret-value@gateway.internal'},
  );

  try {
    await client.complete({prompt: 'p'});
    throw new Error('expected complete to throw');
  } catch (error) {
    expect((error as MistralError).message).not.toContain('sk-secret-value');
    expect((error as MistralError).message).not.toContain('user:sk-secret-value');
  }
});

test('still names the host in a connection-failure message when the base URL carries no credentials', async () => {
  const client = clientWith(
    async () => {
      throw new sdkErrors.ConnectionError('socket hang up', {cause: new Error('socket hang up')});
    },
    {baseUrl: 'https://gateway.internal'},
  );

  await expect(client.complete({prompt: 'p'})).rejects.toThrow(/gateway\.internal/);
});

test('maps a timeout and names the env var to raise', async () => {
  const client = clientWith(async () => {
    throw new sdkErrors.RequestTimeoutError('timed out', {cause: new Error('timed out')});
  });
  await expect(client.complete({prompt: 'p'})).rejects.toThrow(/MISTRAL_TIMEOUT_MS/);
});

test('maps 401 to a credentials message that never echoes the key', async () => {
  const client = clientWith(async () => {
    throw sdkHttpError(401);
  });

  try {
    await client.complete({prompt: 'p'});
    throw new Error('expected complete to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(MistralError);
    expect((error as MistralError).status).toBe(401);
    expect((error as MistralError).message).toMatch(/MISTRAL_API_KEY/);
    expect((error as MistralError).message).not.toContain('sk-test-key');
  }
});

test('maps 429 to rate-limit guidance', async () => {
  const client = clientWith(async () => {
    throw sdkHttpError(429);
  });
  await expect(client.complete({prompt: 'p'})).rejects.toThrow(/rate limit/i);
});

test('maps any other HTTP status to a failure carrying that status', async () => {
  const client = clientWith(async () => {
    throw sdkHttpError(503);
  });

  try {
    await client.complete({prompt: 'p'});
    throw new Error('expected complete to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(MistralError);
    expect((error as MistralError).status).toBe(503);
  }
});

test('does not leak the raw SDK error text, which can embed the request body', async () => {
  const client = clientWith(async () => {
    throw new sdkErrors.SDKError('failed', {
      response: new Response('{"error":"key sk-test-key is revoked"}', {status: 400}),
      request: new Request('https://api.mistral.ai/v1/chat/completions'),
      body: '{"error":"key sk-test-key is revoked"}',
    });
  });

  try {
    await client.complete({prompt: 'p'});
    throw new Error('expected complete to throw');
  } catch (error) {
    expect((error as MistralError).message).not.toContain('sk-test-key');
  }
});

test('wraps an unrecognised failure without leaking its text', async () => {
  const client = clientWith(async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:443 apiKey=sk-test-key');
  });

  try {
    await client.complete({prompt: 'p'});
    throw new Error('expected complete to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(MistralError);
    expect((error as MistralError).message).not.toContain('sk-test-key');
    expect((error as MistralError).message).not.toContain('10.0.0.5');
    // This error's MESSAGE says ECONNREFUSED but it carries no `code`, and it must therefore not
    // be classified as a connection failure: the classifier reads `code` and `name` only. An SDK
    // error's message can contain the response body, and a response body has been observed
    // carrying the API key — so matching on message text is how a leak starts.
    expect((error as MistralError).message).not.toMatch(/reach the Mistral API/i);
  }
});

test('maps an upstream 429 to rate-limit guidance through the real retry loop', async () => {
  const error = await errorFromServer(() => jsonResponse(429, '{"message":"rate limited"}'));
  expect(error.status).toBe(429);
  expect(error.message).toMatch(/rate limit/i);
});

test('maps an upstream 500 through the real retry loop, carrying the status', async () => {
  const error = await errorFromServer(() => jsonResponse(500, '{"message":"boom"}'));
  expect(error.status).toBe(500);
  expect(error.message).toContain('500');
});

test('reports a 200 the SDK could not read as a response-shape problem, not "HTTP 200"', async () => {
  const error = await errorFromServer(() => jsonResponse(200, '{"not":"a completion"}'));
  expect(error.status).toBe(200);
  expect(error.message).not.toMatch(/failed: HTTP 200/);
  expect(error.message).toMatch(/shape/i);
});

test('maps a refused connection to reachability guidance naming the host', async () => {
  const port = await closedPort();
  const client = new MistralClient({
    ...config,
    timeoutMs: 1_000,
    baseUrl: `http://127.0.0.1:${port}`,
  });

  try {
    await client.complete({prompt: 'p'});
    throw new Error('expected complete to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(MistralError);
    expect((error as MistralError).message).toMatch(/reach the Mistral API/i);
    expect((error as MistralError).message).toContain(`127.0.0.1:${port}`);
    expect((error as MistralError).message).toMatch(/MISTRAL_BASE_URL/);
  }
});

test('strips credentials from the base URL of a real refused connection', async () => {
  // The same guarantee as the unit test above, but reached the way an operator reaches it: a
  // gateway URL with userinfo in it, and a connection that genuinely fails. Until the classifier
  // recognised Bun's connection errors this path never ran, so `sanitizedBaseUrl` was guarding a
  // branch nothing could enter.
  const port = await closedPort();
  const client = new MistralClient({
    ...config,
    timeoutMs: 1_000,
    baseUrl: `http://gateway:sk-secret-value@127.0.0.1:${port}`,
  });

  try {
    await client.complete({prompt: 'p'});
    throw new Error('expected complete to throw');
  } catch (error) {
    const {message} = error as MistralError;
    expect(message).toMatch(/reach the Mistral API/i);
    expect(message).toContain(`127.0.0.1:${port}`);
    expect(message).not.toContain('sk-secret-value');
    expect(message).not.toContain('gateway:');
  }
});
