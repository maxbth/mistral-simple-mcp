import {test, expect} from 'bun:test';

/**
 * `noUncheckedIndexedAccess` types `lines[0]` as possibly `undefined`, and
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

test('exits cleanly when stdin reaches EOF', async () => {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', '--stdio'], {
    // `Bun.env` is used here instead of reading `process`'s `env` property directly: that
    // member access is restricted repo-wide to config.ts (see eslint.config.mjs's
    // RESTRICTED_SYNTAX) to keep environment reads centralized in one place. That rule exists to
    // stop this process from reading its own config ad hoc; it does not apply to building the
    // environment for a *child* process spawned as a test fixture, but the lint rule matches the
    // member access syntactically and cannot tell the two apart. `Bun.env` is the same data under
    // a different global, so it carries the same inherited PATH etc. without tripping the rule or
    // requiring a disable comment. Precedent: transports/stdio.test.ts in the sibling project this
    // transport layer was modeled on does the same, for the same reason.
    env: {
      ...Bun.env,
      MISTRAL_API_KEY: 'sk-not-a-real-key',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Closing stdin is the EOF the SDK's transport ignores and stdio.ts handles.
  proc.stdin.end();

  const exitCode = await Promise.race([proc.exited, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000))]);

  if (exitCode === 'timeout') {
    proc.kill();
    throw new Error('the stdio server did not exit within 5s of stdin EOF');
  }
  expect(exitCode).toBe(0);
});

test('answers an initialize request on stdout and writes nothing else there', async () => {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', '--stdio'], {
    // `Bun.env`, not `process`'s `env` property — see the comment on the identical line above.
    env: {
      ...Bun.env,
      MISTRAL_API_KEY: 'sk-not-a-real-key',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: 'test',
        version: '0.0.0',
      },
    },
  };
  proc.stdin.write(`${JSON.stringify(request)}\n`);
  proc.stdin.flush();

  /*
   * The SDK frames stdio messages as newline-delimited JSON (`serializeMessage` in
   * @modelcontextprotocol/server's stdio transport appends "\n" per message — confirmed by
   * reading dist/src-*.mjs), which matches this test's parsing below. But the process stays
   * alive after replying; it does not close stdout on its own. `new Response(stream).text()`
   * waits for the stream to close, which never happens here, so it always falls through to the
   * timeout branch and yields an empty string — the test would then fail for the wrong reason
   * (no output captured) rather than the reason it exists to catch (bad output). Reading
   * incrementally and stopping once one full line has arrived fixes that, while keeping the same
   * 5s budget as a safety net against a server that never replies.
   */
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 5_000;
  try {
    while (!buffer.includes('\n') && Date.now() < deadline) {
      const outcome = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), Math.max(deadline - Date.now(), 0))),
      ]);
      if (outcome === 'timeout' || outcome.done) {
        break;
      }
      buffer += decoder.decode(outcome.value, {stream: true});
    }
  } finally {
    // `() => undefined`, not `() => {}`: an empty block body trips
    // @typescript-eslint/no-empty-function, while a concise-body arrow does not.
    await reader.cancel().catch(() => undefined);
  }

  proc.stdin.end();
  proc.kill();

  // Every stdout line must be protocol JSON. A stray log line here corrupts the stream, which
  // is the failure this assertion exists to catch.
  const lines = buffer.split('\n').filter((line) => line.trim().length > 0);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(() => JSON.parse(line)).not.toThrow();
  }
  expect(JSON.parse(first(lines))).toMatchObject({
    jsonrpc: '2.0',
    id: 1,
  });
}, 10_000);
