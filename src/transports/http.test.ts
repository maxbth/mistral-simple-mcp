import {test, expect} from 'bun:test';
import {buildHttpApp} from './http';
import type {Config} from '../config';
import type {MistralClient} from '../mistral-client';

function config(overrides: Partial<Config['mcp']> = {}): Config {
  return {
    mistral: {
      apiKey: 'sk-test-key',
      model: 'mistral-medium-latest',
      timeoutMs: 60_000,
    },
    mcp: {
      transport: 'http',
      host: '127.0.0.1',
      port: 3_000,
      path: '/mcp',
      allowedOrigins: [],
      ...overrides,
    },
  };
}

const deps = {client: {} as unknown as MistralClient};

/*
 * `app.fetch()` builds a bare `Request` in-process, without going through a real socket — unlike
 * a real HTTP/1.1 connection, no `Host` header is attached unless one is supplied explicitly.
 * `createMcpHonoApp` installs Host validation on every route for a localhost-class bind (see
 * `http.ts`), so every `/mcp` request below carries one that matches the `127.0.0.1` bind used by
 * `config()`. `/health` is exempt (it is answered by the outer app, before that middleware runs),
 * which is why it does not need one.
 */
const MCP_HOST_HEADER = {Host: '127.0.0.1'};

/*
 * A well-formed Streamable HTTP request needs a JSON `Content-Type` (the MCP handler answers
 * anything else with 415) and an `Accept` that names both response modes it may choose between.
 * `ping` is a bodyless protocol-level method — it needs no tool and never touches `deps.client`,
 * which is the fake object below — so a 200 here can only mean the request cleared Host/Origin
 * validation, cleared the bearer check, and was answered by the real MCP handler. Pattern and
 * exact headers match transports/http.test.ts in the sibling project this transport layer was
 * modeled on (e.g. its "mcp endpoint is reachable without a token when none is configured"
 * test), the working reference against the same SDK version.
 */
const MCP_JSON_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const PING_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'ping',
});

test('health is served without a token', async () => {
  const {app, close} = buildHttpApp(config({authToken: 'secret-token'}), deps);
  const response = await app.fetch(new Request('http://127.0.0.1:3000/health'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({status: 'ok'});
  await close();
});

test('mcp rejects a request with no bearer token when one is configured', async () => {
  const {app, close} = buildHttpApp(config({authToken: 'secret-token'}), deps);
  const response = await app.fetch(
    new Request('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: MCP_HOST_HEADER,
    }),
  );
  expect(response.status).toBe(401);
  await close();
});

test('mcp rejects a wrong bearer token', async () => {
  const {app, close} = buildHttpApp(config({authToken: 'secret-token'}), deps);
  const response = await app.fetch(
    new Request('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: {
        ...MCP_HOST_HEADER,
        Authorization: 'Bearer wrong-token',
      },
    }),
  );
  expect(response.status).toBe(401);
  await close();
});

test('mcp rejects a wrong bearer token of the same length as the real one', async () => {
  // 'wrong-secret' and 'secret-token' are both 12 characters (verified: 'secret-token'.length
  // === 'wrong-secret'.length === 12). A wrong token of a DIFFERENT length is caught by
  // `tokensMatch`'s early return on length mismatch and never reaches the XOR comparison loop —
  // that's the test above. Matching the length forces the loop itself to run, which is the
  // security-relevant, constant-time part of the comparison.
  const {app, close} = buildHttpApp(config({authToken: 'secret-token'}), deps);
  const response = await app.fetch(
    new Request('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: {
        ...MCP_HOST_HEADER,
        Authorization: 'Bearer wrong-secret',
      },
    }),
  );
  expect(response.status).toBe(401);
  await close();
});

test('mcp accepts a correct bearer token and reaches the handler', async () => {
  const {app, close} = buildHttpApp(config({authToken: 'secret-token'}), deps);
  const response = await app.fetch(
    new Request('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: {
        ...MCP_HOST_HEADER,
        ...MCP_JSON_HEADERS,
        Authorization: 'Bearer secret-token',
      },
      body: PING_BODY,
    }),
  );
  // An exact 200 rather than `not.toBe(401)`: the latter is equally satisfied by a 403 from
  // failed Host/Origin validation, a 415 from a missing Content-Type, or any other non-401
  // rejection — which is precisely how the tests this replaces stayed green while testing
  // nothing. Only a 200 proves the request cleared the bearer check AND reached the real
  // handler.
  expect(response.status).toBe(200);
  await close();
});

test('mcp rejects a disallowed Origin while still serving a request that sends none', async () => {
  /*
   * The two halves of what an empty `MCP_ALLOWED_ORIGINS` is documented to mean (see `http.ts`):
   * reject every request that carries an `Origin`, let a header-less non-browser client through.
   * They are asserted together because either alone passes for the wrong reason — a server that
   * rejected everything would satisfy the first, and one with Origin validation switched off
   * entirely would satisfy the second.
   *
   * `config()` binds `127.0.0.1`, which is localhost-class, so `effectiveAllowedOrigins` seeds the
   * SDK's own localhost hostnames back in. `https://evil.example` is not among them, and with
   * `allowedOrigins` empty nothing adds it.
   */
  const {app, close} = buildHttpApp(config(), deps);

  const fromABrowserPage = await app.fetch(
    new Request('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: {
        ...MCP_HOST_HEADER,
        ...MCP_JSON_HEADERS,
        Origin: 'https://evil.example',
      },
      body: PING_BODY,
    }),
  );
  expect(fromABrowserPage.status).toBe(403);

  const fromANonBrowserClient = await app.fetch(
    new Request('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: {
        ...MCP_HOST_HEADER,
        ...MCP_JSON_HEADERS,
      },
      body: PING_BODY,
    }),
  );
  expect(fromANonBrowserClient.status).toBe(200);

  await close();
});

test('mcp still validates Origin on a wildcard bind, where the allowlist really is empty', async () => {
  /*
   * The case the localhost test above cannot reach, and the one `http.ts` says matters most.
   *
   * On `127.0.0.1`, `effectiveAllowedOrigins` seeds the SDK's localhost hostnames in, so a 403
   * there is also what a server that merely inherited a default allowlist would produce. On
   * `0.0.0.0` nothing is seeded: the list handed to `createMcpHonoApp` is literally `[]`. That is
   * the difference between passing an empty array and passing `undefined` — the first rejects
   * every `Origin` there is, the second switches Origin validation off, and on a wildcard bind
   * that is the whole of the DNS-rebinding protection.
   *
   * A token is configured because a wildcard bind without one warns on stderr, and because it is
   * the compensating control that path is documented to require. Every request below carries it,
   * so a 403 can only have come from Origin validation.
   */
  const {app, close} = buildHttpApp(
    config({
      host: '0.0.0.0',
      authToken: 'secret-token',
    }),
    deps,
  );
  const authorized = {Authorization: 'Bearer secret-token'};

  for (const origin of ['https://evil.example', 'http://localhost:3000']) {
    const fromABrowserPage = await app.fetch(
      new Request('http://127.0.0.1:3000/mcp', {
        method: 'POST',
        headers: {
          ...MCP_JSON_HEADERS,
          ...authorized,
          Origin: origin,
        },
        body: PING_BODY,
      }),
    );
    expect(fromABrowserPage.status).toBe(403);
  }

  // And the other half: a client that sends no Origin at all is still served, so the 403s above
  // are Origin validation doing its job rather than the wildcard bind rejecting everything.
  const fromANonBrowserClient = await app.fetch(
    new Request('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: {
        ...MCP_JSON_HEADERS,
        ...authorized,
      },
      body: PING_BODY,
    }),
  );
  expect(fromANonBrowserClient.status).toBe(200);

  await close();
});

test('mcp accepts requests without auth when no token is configured, and reaches the handler', async () => {
  const {app, close} = buildHttpApp(config(), deps);
  const response = await app.fetch(
    new Request('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: {
        ...MCP_HOST_HEADER,
        ...MCP_JSON_HEADERS,
      },
      body: PING_BODY,
    }),
  );
  expect(response.status).toBe(200);
  await close();
});
