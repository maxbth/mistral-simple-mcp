# Known limitations

Deliberate trade-offs and things worth knowing before deploying this. Each is reproducible; none is
speculative.

## `mistral_extract` does not support `$ref`, so recursive schemas are out

The tool compiles a caller-supplied JSON Schema with `z.fromJSONSchema` and validates the model's
response against it. Two constructs make that cost wildly disproportionate to the size of the
schema, and both are rejected before any model call:

1. **`$ref`, in any form.** A reference lets a few hundred bytes describe a large or infinite
   structure. A cycle that never descends through `properties` or `items` produces a validator that
   recurses without consuming input and never returns at all — a synchronous hang, which no
   `try`/`catch` or timeout inside the process can recover from.
2. **An array-valued `type` on a node that also has subschemas under it.** Zod converts that node's
   children once per entry in the array, so work doubles per level while the document grows by a few
   characters per level. Measured on Zod 4.4.3:
   `{"type":["object","object"],"properties":{…}}` nested 18 deep is **881 bytes and 3.5 seconds**;
   at 22 deep it is ~18 seconds.

Everything else is proportional to the size of the schema, which the transport already bounds — a
300 KB schema compiles in about 13 ms, and deep nesting, `allOf`, `anyOf` and `patternProperties`
all scale linearly. A schema deep enough to exhaust the stack throws `RangeError`, which is caught
and returned as a normal error.

**The practical cost is recursive schemas.** A tree or linked-list shape needs `$ref`, so it cannot
be expressed. Everything else is unaffected, and in particular the common nullable idiom still works:
an array-valued `type` on a leaf — `{"type": ["string", "null"]}` — has no children to multiply and
compiles in well under a millisecond however deeply it is nested.

This was previously handled by compiling on a worker thread under a wall-clock timeout, which
covered any expensive schema rather than two named ones. That was removed deliberately: it cost a
worker pool, a generation-lease protocol, a second build entry point, and a file-descriptor leak in
Bun's `Worker` — roughly 1,400 lines — to support a feature (recursive extraction schemas) nobody
had asked for. Rejecting the two constructs is a few dozen lines and no runtime machinery.

If recursive schemas ever matter, the worker approach is in this branch's history rather than lost.

## Other items

- **`MISTRAL_BASE_URL` accepts any URL scheme.** `z.string().url()` permits `ftp:`, `javascript:`,
  `data:`. Operator-controlled rather than caller-controlled, so not reachable by a caller.
- **Whitespace-only `prompt` or `system` passes validation** and will spend a real API call.
  `z.string().min(1)` accepts `" "`.
- **Extra properties in a response are not stripped.** The caller's schema is sent to Mistral
  verbatim with no normalization, so it does not forbid additional properties and they pass through
  into `data`. This is the intended consequence of the verbatim-schema design.
- **The container image has never been built or run.** Docker was unavailable on the machine where
  this was developed. The Dockerfile, healthcheck and compose file are correct by inspection, and
  the build command was run locally with the resulting bundle verified to serve a real extraction —
  but no `docker build` has been executed. Run one before tagging an image.

## Deliberately out of scope for v1

Strict-mode schema normalization (`additionalProperties: false` everywhere, every property in
`required`) is not implemented, so `strict` defaults to `false` and Mistral's constrained decoding
is not guaranteeing the response shape — `safeParse` is what holds the contract.
