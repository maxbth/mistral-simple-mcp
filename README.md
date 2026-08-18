# mistral-simple-mcp

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives an agent two tools
backed by [Mistral](https://mistral.ai): single-shot text completion, and structured data
extraction validated against a JSON Schema you supply.

An independent project, not affiliated with or endorsed by Mistral AI.

## What this is

Two tools, served over Streamable HTTP and stdio:

- **`mistral_complete`** — single-shot text completion: summarize, rewrite, classify, draft.
- **`mistral_extract`** — structured data extraction against a JSON Schema you supply, with the
  response validated before it comes back.

Streamable HTTP is served at `POST /mcp`; stdio is selected with the `--stdio` flag. Both tools
call a paid, non-deterministic API, so neither is annotated as read-only or idempotent.

## Quick start

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
cp .env.example .env
# edit .env and set MISTRAL_API_KEY (console.mistral.ai/api-keys)
bun run dev
```

The server starts on Streamable HTTP by default, listening at `http://127.0.0.1:3000/mcp`.
`GET /health` answers `{"status":"ok"}` once it's up.

## Client configuration

### stdio

For a client that spawns the server as a subprocess — Claude Code, Claude Desktop, or anything
else that launches a process and speaks MCP over stdin/stdout:

```json
{
  "mcpServers": {
    "mistral": {
      "command": "bun",
      "args": ["run", "/path/to/mistral-simple-mcp/src/index.ts", "--stdio"],
      "env": {
        "MISTRAL_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

`--stdio` overrides `MCP_TRANSPORT` no matter what `.env` says. After `bun run build`, point
`args` at `dist/index.js` instead of `src/index.ts` — both run the same server.

### Streamable HTTP

Start the server (`bun run dev`, or the Docker image below), then point a client at `/mcp`:

```json
{
  "mcpServers": {
    "mistral": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

If `MCP_AUTH_TOKEN` is set, add a matching header:

```json
{
  "mcpServers": {
    "mistral": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {"Authorization": "Bearer YOUR_TOKEN_HERE"}
    }
  }
}
```

## When to use it

**Delegating a bounded subtask to a separate model.** An agent already holding a large context of
its own can hand off a self-contained piece of work — summarizing a document, rewriting a
paragraph in a different tone, classifying a support ticket — to `mistral_complete` instead of
doing it inline. Each call is single-shot and keeps no conversation state between invocations, so
this fits a "delegate, get an answer, continue" pattern rather than a back-and-forth chat.

**Getting schema-validated JSON out of unstructured text.** When a completion's result is going to
be read by code rather than a person — parsed into a struct, inserted into a database, passed to
another tool — `mistral_extract` is the better fit. Supply a JSON Schema describing the shape you
need; the response is validated against that same schema before it's returned, so a successful
call is guaranteed to match, and a mismatch comes back as a clear, retryable error instead of
downstream code tripping over the wrong shape.

## Tool reference

Descriptions below are copied from each tool's own schema, so this section and the server cannot
drift apart. Example responses show the request/response shape; exact wording and token counts
will differ per call.

### `mistral_complete`

Generate text with a Mistral model. Use this to delegate a self-contained subtask — summarizing,
rewriting, classifying, drafting — to a separate model. Send the whole input in `prompt`; this is
a single-shot call that keeps no conversation state between invocations. For output that must
match a specific JSON shape, use `mistral_extract` instead.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | string | yes | — | The instruction and any input text it operates on. |
| `system` | string | no | none | System prompt setting the role, tone or output rules. |
| `model` | `mistral-small-latest` \| `mistral-medium-latest` \| `mistral-large-latest` | no | server-configured model (`MISTRAL_DEFAULT_MODEL`) | Model to use. Defaults to the server-configured model. |
| `temperature` | number, 0–2 | no | Mistral's own default | Sampling temperature. Lower is more deterministic. Mistral recommends 0.0-0.7. |
| `maxTokens` | integer > 0 | no | Mistral's own default | Maximum tokens to generate. |

**Example call**

```json
{
  "prompt": "Rewrite this for a support ticket, one sentence: users cant login when they use special chars in password",
  "system": "You write clear, professional bug report summaries.",
  "temperature": 0.2
}
```

**Example response**

```json
{
  "text": "Login fails for users whose password contains special characters.",
  "model": "mistral-medium-latest",
  "finishReason": "stop",
  "usage": {
    "promptTokens": 42,
    "completionTokens": 12,
    "totalTokens": 54
  }
}
```

### `mistral_extract`

Extract structured data matching a JSON Schema you supply. Returns an object validated against
that schema, so a successful call always matches the shape requested. Use this instead of
`mistral_complete` whenever the result is going to be read by code rather than a person. Optional
properties are returned absent, not null.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | string | yes | — | The instruction and the text to extract from. |
| `schema` | object (JSON Schema) | yes | — | JSON Schema describing the object to return. Standard JSON Schema: an object with `type`, `properties` and `required`, nested as deeply as you need. Two things are rejected before any model call, both because they make a small schema extremely expensive to compile: `$ref` in any form — inline the definition instead, and note that this means recursive shapes cannot be expressed — and an array-valued `type` on a node that also has subschemas under it, so give such a node a single `type`. An array-valued `type` is fine on a node with no subschemas, so `{"type": ["string", "null"]}` is the way to say a field is nullable. Constructs Zod cannot represent, such as if/then/else and not, are also rejected before any model call. |
| `schemaName` | string, matching `^[a-zA-Z0-9_-]+$` | no | `extraction` | Name for the schema in the API request. Letters, digits, underscores and hyphens only. |
| `system` | string | no | none | System prompt setting extraction rules. |
| `model` | `mistral-small-latest` \| `mistral-medium-latest` \| `mistral-large-latest` | no | server-configured model (`MISTRAL_DEFAULT_MODEL`) | Model to use. Defaults to the server-configured model. |
| `temperature` | number, 0–2 | no | Mistral's own default | Sampling temperature. Extraction usually wants a low value. |
| `strict` | boolean | no | `false` | Enable Mistral strict mode. Requires the schema to set `additionalProperties: false` on every object and list every property in `required`; Mistral rejects the request otherwise. Leave false unless the schema meets those conditions. |

**Example call**

```json
{
  "prompt": "Extract the person described: Ada Lovelace, age 36.",
  "schema": {
    "type": "object",
    "properties": {
      "name": {"type": "string"},
      "age": {"type": "integer"}
    },
    "required": ["name", "age"]
  },
  "schemaName": "person"
}
```

**Example response**

```json
{
  "data": {
    "name": "Ada Lovelace",
    "age": 36
  },
  "model": "mistral-medium-latest",
  "usage": {
    "promptTokens": 20,
    "completionTokens": 8,
    "totalTokens": 28
  }
}
```

See [Structured output](#structured-output) below for what `schema` can and can't express.

## Structured output

`mistral_extract`'s `schema` argument is sent to Mistral **verbatim** — it is never normalized or
rewritten. That is what makes the rest of this section true.

**The schema is compiled to a Zod validator, and that validator checks the response.** Both happen
inline: compiling is cheap, and the two constructs that could make it expensive are refused first.
Anything Zod cannot represent — `if`/`then`/`else`, `not`, `dependentSchemas`,
`unevaluatedProperties` — fails at compile time, before any request is sent, and the tool call
reports a message naming the problem. A bad schema costs nothing.

**`$ref` is not supported, in any form.** Inline the definition instead. A reference lets a few
hundred bytes describe a large or infinite structure, and a cycle that never descends through
`properties` or `items` compiles fine and then never returns when a response is checked against it,
because it recurses without ever looking at the data. The practical consequence is that **recursive
schemas cannot be expressed** — a tree or linked-list shape needs `$ref`. If that matters for your
use case, this is the limitation to weigh.

**An array-valued `type` is rejected on a node that has subschemas under it.** The compiler converts
that node's children once per entry in the array, so cost doubles at every level while the document
grows by a few characters per level. `{"type": ["object", "object"], "properties": {…}}` nested 18
deep is 881 bytes and takes 3.5 seconds; at 22 deep, about 18. Give such a node a single `type`.

**An array-valued `type` on a leaf is fine**, which is the case that actually comes up:
`{"type": ["string", "null"]}` is the ordinary way to say a field is nullable, has no children to
multiply, and compiles in well under a millisecond however deeply it is nested.

With those two refused, the remaining cost is proportional to the size of the schema, which the
transport already bounds — a 300 KB schema compiles in about 13 ms, and deep nesting, `allOf`,
`anyOf` and `patternProperties` all scale linearly. A schema deep enough to exhaust the stack
throws, and that is caught and reported like any other schema problem.

**The response is validated before it is returned.** Because the schema is not normalized, `strict`
defaults to `false` and Mistral's constrained decoding is not guaranteeing the shape — this
validation is what holds the tool's contract. A mismatch comes back as a `SchemaError` listing each
offending field path, so a calling model can correct and retry rather than guess.

**Optional properties come back absent, not null**, and **extra properties are not stripped**. Both
follow from sending the schema verbatim: an optional property stays optional, and a schema that does
not set `additionalProperties: false` does not forbid extras.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `MISTRAL_API_KEY` | — | **required** |
| `MISTRAL_DEFAULT_MODEL` | `mistral-medium-latest` | `mistral-small-latest`, `mistral-medium-latest`, or `mistral-large-latest` |
| `MISTRAL_TIMEOUT_MS` | `60000` | per-request timeout; also bounds retry backoff (see below) |
| `MISTRAL_BASE_URL` | unset | self-hosted or proxied endpoints; must be a valid URL |
| `MCP_TRANSPORT` | `http` | `http` or `stdio`; the `--stdio` CLI flag overrides this |
| `MCP_HOST` | `127.0.0.1` | the image sets `0.0.0.0` |
| `MCP_PORT` | `3000` | |
| `MCP_HTTP_PATH` | `/mcp` | the HTTP path the MCP endpoint is served on; must start with `/` |
| `MCP_AUTH_TOKEN` | unset | when set, a matching bearer token is required on `/mcp` |
| `MCP_ALLOWED_ORIGINS` | empty | comma-separated **hostnames** (not full origins), added to the localhost defaults on a localhost bind |

There is deliberately no retry-count setting. The Mistral SDK has no attempt-count option — its
retry behavior is a backoff shape (initial interval, max interval, exponent), not a fixed number
of tries — so the knob this server exposes is `MISTRAL_TIMEOUT_MS`, which bounds how long that
backoff sequence is allowed to run rather than how many times it runs. The retry budget is set to
80% of it, deliberately less than the whole: the SDK only reports the upstream response once its
retry budget is spent, so a budget equal to the deadline means a rate limit comes back as a
timeout instead of as a rate limit.

## Docker

```bash
docker build -t mistral-simple-mcp .
docker run -d -p 3000:3000 \
  -e MISTRAL_API_KEY=your-api-key-here \
  -e MCP_AUTH_TOKEN=generate-a-long-random-string \
  mistral-simple-mcp
```

Or with Compose — copy [`docker-compose.example.yml`](docker-compose.example.yml), fill in the
two values, and run `docker compose -f docker-compose.example.yml up -d`:

```yaml
services:
  mistral-simple-mcp:
    image: ghcr.io/maxbth/mistral-simple-mcp:latest
    ports:
      - '3000:3000'
    environment:
      MISTRAL_API_KEY: your-api-key-here
      MCP_AUTH_TOKEN: generate-a-long-random-string
    restart: unless-stopped
```

For stdio instead, keep the entrypoint and override the default args:

```bash
docker run -i --rm -e MISTRAL_API_KEY=your-api-key-here mistral-simple-mcp --stdio
```

### `MCP_AUTH_TOKEN` and `0.0.0.0`

The image binds `MCP_HOST=0.0.0.0` so the container is reachable from outside itself — a container
listening on `127.0.0.1` only accepts connections from inside its own network namespace, which in
practice means none. **Always set `MCP_AUTH_TOKEN`** when running the image: without it, anything
that can reach the published port can call `mistral_complete` and `mistral_extract` with no
authentication at all, and spend the owner's Mistral API credits doing it. The server logs a
warning to stderr on startup whenever it's bound wide open with no token configured.

`MCP_AUTH_TOKEN` protects `/mcp` with a constant-time bearer-token check. `/health` stays
unauthenticated on purpose — it returns nothing but `{"status":"ok"}`, and container runtimes need
to reach it without a token to run their health probe.

## Known limitations

`mistral_extract` compiles JSON Schema supplied by the caller, so it refuses the two constructs
that make compilation cost wildly more than the schema's size suggests: `$ref` in any form, and an
array-valued `type` on a node that has subschemas under it. The practical cost is that **recursive
schemas are not supported**.

See [docs/known-limitations.md](docs/known-limitations.md) for the full list, including the three
known unbounded-work classes and what defends against them.

## Development

```bash
bun install
bun test
bun run typecheck   # Bun does not typecheck; this is what does
bun run lint:check
```

`bun run lint:check` does not catch every formatting rule Prettier enforces — trailing commas
in particular have no ESLint equivalent in this config, so lint can pass on a diff Prettier
would still reject. Treat it as a separate gate and run it before committing:

```bash
bunx prettier --check src scripts   # or: bun run format, to fix in place
```

Tests are colocated with what they test (`src/config.ts` / `src/config.test.ts`), run with no
network access and no real API key — a fake `MistralClient` is injected in place of the real one.

**`bun run build` bundles and then runs what it built.**

```bash
bun run build          # bundle into dist/, then verify it
bun run verify:build   # just the verification, against an existing dist/
```

`build` bundles `src/index.ts` to `dist/`. The Dockerfile runs the same command with `--minify`.

## License

[MIT](LICENSE.md) © Maxime Bertheau
