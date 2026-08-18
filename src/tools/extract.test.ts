import {test, expect} from 'bun:test';
import tool from './extract';
import {SchemaError} from '../errors';
import type {MistralClient, CompleteRequest} from '../mistral-client';

/*
 * `mistral_extract` can reject a caller's schema at three different points, in this order: the
 * static gate (`findSchemaDefect`, before anything else runs), the `z.fromJSONSchema` compile
 * (still before the API call), and validation of the model's response (after the API call, so it
 * is the one place `neverCalledClient` would be the wrong tool). The three groups of tests below
 * are organised around that order.
 */

const personSchema = {
  type: 'object',
  properties: {
    name: {type: 'string'},
    age: {type: 'integer'},
  },
  required: ['name', 'age'],
};

function fakeClient(text: string, onComplete?: (request: CompleteRequest) => void): MistralClient {
  return {
    complete: async (request: CompleteRequest) => {
      onComplete?.(request);
      return {
        text,
        model: 'mistral-medium-latest',
        finishReason: 'stop',
        usage: {
          promptTokens: 20,
          completionTokens: 8,
          totalTokens: 28,
        },
      };
    },
  } as unknown as MistralClient;
}

/** A client that fails the test if it is ever called. */
function neverCalledClient(): MistralClient {
  return {
    complete: async () => {
      throw new Error('the API must not be called when the schema is unusable');
    },
  } as unknown as MistralClient;
}

/**
 * `{"type":["object","object"],"properties":{"child":...}}` nested `depth` deep — the construct
 * `findSchemaDefect` exists to catch before it ever reaches `z.fromJSONSchema`. See json-schema.ts
 * for the measurements: at depth 18 this is 881 bytes and takes 3.5 seconds to compile. Used here
 * to prove the gate rejects it outright, without ever calling the compiler.
 */
function typeArrayFanOut(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = {type: 'string'};
  for (let level = 0; level < depth; level += 1) {
    node = {
      type: ['object', 'object'],
      properties: {child: node},
    };
  }
  return node;
}

test('is named mistral_extract and is not marked read-only', () => {
  expect(tool.name).toBe('mistral_extract');
  expect(tool.config.annotations.readOnlyHint).toBe(false);
});

test('returns parsed data alongside the model and usage', async () => {
  const client = fakeClient('{"name":"Ada","age":36}');
  const result = (await tool.handler(
    {
      prompt: 'p',
      schema: personSchema,
      schemaName: 'person',
      strict: false,
    },
    {client},
  )) as Record<string, unknown>;

  expect(result.data).toEqual({
    name: 'Ada',
    age: 36,
  });
  expect(result.model).toBe('mistral-medium-latest');
  expect(result.usage).toEqual({
    promptTokens: 20,
    completionTokens: 8,
    totalTokens: 28,
  });
});

test('sends the schema verbatim in a json_schema response format', async () => {
  let seen: CompleteRequest | undefined;
  const client = fakeClient('{"name":"Ada","age":36}', (request) => {
    seen = request;
  });

  await tool.handler(
    {
      prompt: 'p',
      schema: personSchema,
      schemaName: 'person',
      strict: false,
    },
    {client},
  );

  expect(seen?.responseFormat).toEqual({
    type: 'json_schema',
    jsonSchema: {
      name: 'person',
      schemaDefinition: personSchema,
      strict: false,
    },
  });
});

test('forwards the strict flag when the caller opts in', async () => {
  let seen: CompleteRequest | undefined;
  const client = fakeClient('{"name":"Ada","age":36}', (request) => {
    seen = request;
  });

  await tool.handler(
    {
      prompt: 'p',
      schema: personSchema,
      schemaName: 'extraction',
      strict: true,
    },
    {client},
  );
  expect((seen?.responseFormat as {jsonSchema: {strict: boolean}}).jsonSchema.strict).toBe(true);
});

/*
 * `findSchemaDefect` only rejects `$ref` and an array-valued `type` paired with a subschema — it
 * has no opinion on every other JSON Schema keyword Zod cannot represent. These four pass the
 * gate and are caught one step later, when `z.fromJSONSchema` itself throws while compiling them.
 * That still happens before the API call, so `neverCalledClient` still proves it.
 */
const compileRejectedSchemas: Array<{
  label: string;
  schema: Record<string, unknown>;
}> = [
  {
    label: 'an if/then/else schema',
    schema: {
      type: 'object',
      properties: {a: {type: 'string'}},
      if: {required: ['a']},
      then: {required: ['a']},
    },
  },
  {
    label: 'a not schema',
    schema: {
      type: 'object',
      properties: {a: {type: 'string'}},
      not: {required: ['a']},
    },
  },
  {
    label: 'a dependentSchemas schema',
    schema: {
      type: 'object',
      properties: {a: {type: 'string'}},
      dependentSchemas: {a: {required: ['a']}},
    },
  },
  {
    label: 'an unevaluatedProperties schema',
    schema: {
      type: 'object',
      properties: {a: {type: 'string'}},
      unevaluatedProperties: false,
    },
  },
];

for (const {label, schema} of compileRejectedSchemas) {
  test(`rejects ${label} before calling the API`, async () => {
    await expect(
      tool.handler(
        {
          prompt: 'p',
          schema,
          schemaName: 'extraction',
          strict: false,
        },
        {client: neverCalledClient()},
      ),
    ).rejects.toBeInstanceOf(SchemaError);
  });
}

/*
 * The two constructs `findSchemaDefect` itself rejects, wired all the way through the handler:
 * each must still throw `SchemaError` before any API call, and the message must name the reason
 * the static check found rather than some other failure.
 */
const gateRejectedSchemas: Array<{
  label: string;
  schema: Record<string, unknown>;
  messageContains: string;
}> = [
  {
    label: 'a schema containing $ref',
    schema: {
      type: 'object',
      properties: {a: {$ref: '#/$defs/a'}},
      $defs: {a: {type: 'string'}},
    },
    messageContains: '`$ref`',
  },
  {
    label: 'a type-array fan-out schema',
    schema: typeArrayFanOut(18),
    messageContains: 'array-valued `type`',
  },
];

for (const {label, schema, messageContains} of gateRejectedSchemas) {
  test(`rejects ${label} before calling the API, naming the reason`, async () => {
    try {
      await tool.handler(
        {
          prompt: 'p',
          schema,
          schemaName: 'extraction',
          strict: false,
        },
        {client: neverCalledClient()},
      );
      throw new Error('expected handler to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as SchemaError).message).toContain(messageContains);
    }
  });
}

test('a nullable property ({"type":["string","null"]}) validates a null value end-to-end', async () => {
  const schema = {
    type: 'object',
    properties: {
      name: {type: 'string'},
      nickname: {type: ['string', 'null']},
    },
    required: ['name', 'nickname'],
  };
  const client = fakeClient('{"name":"Ada","nickname":null}');
  const result = (await tool.handler(
    {
      prompt: 'p',
      schema,
      schemaName: 'extraction',
      strict: false,
    },
    {client},
  )) as Record<string, unknown>;

  expect(result.data).toEqual({
    name: 'Ada',
    nickname: null,
  });
});

test('a required-field mismatch reaches the API and fails validation there, rather than at the gate', async () => {
  let called = 0;
  const client = fakeClient('{"name":"Ada"}', () => {
    called += 1;
  });
  await expect(
    tool.handler(
      {
        prompt: 'p',
        schema: personSchema,
        schemaName: 'extraction',
        strict: false,
      },
      {client},
    ),
  ).rejects.toBeInstanceOf(SchemaError);
  // The distinction the gate must not blur: this schema is fine, the response is not.
  expect(called).toBe(1);
});

test('reports non-JSON output as a schema error', async () => {
  const client = fakeClient('Sorry, I cannot do that.');
  await expect(
    tool.handler(
      {
        prompt: 'p',
        schema: personSchema,
        schemaName: 'extraction',
        strict: false,
      },
      {client},
    ),
  ).rejects.toBeInstanceOf(SchemaError);
});

test('reports a shape mismatch with the offending field path', async () => {
  const client = fakeClient('{"name":"Ada","age":"thirty-six"}');
  try {
    await tool.handler(
      {
        prompt: 'p',
        schema: personSchema,
        schemaName: 'extraction',
        strict: false,
      },
      {client},
    );
    throw new Error('expected handler to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as SchemaError).message).toContain('age');
  }
});

test('reports a missing required field', async () => {
  const client = fakeClient('{"name":"Ada"}');
  await expect(
    tool.handler(
      {
        prompt: 'p',
        schema: personSchema,
        schemaName: 'extraction',
        strict: false,
      },
      {client},
    ),
  ).rejects.toBeInstanceOf(SchemaError);
});

test('an absent optional property validates, since the schema is sent unmodified', async () => {
  const schema = {
    type: 'object',
    properties: {
      name: {type: 'string'},
      city: {type: 'string'},
    },
    required: ['name'],
  };
  const client = fakeClient('{"name":"Ada"}');
  const result = (await tool.handler(
    {
      prompt: 'p',
      schema,
      schemaName: 'extraction',
      strict: false,
    },
    {client},
  )) as Record<string, unknown>;
  expect(result.data).toEqual({name: 'Ada'});
});

test('defaults schemaName to extraction and strict to false', () => {
  const parsed = tool.config.inputSchema.safeParse({
    prompt: 'p',
    schema: personSchema,
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    const data = parsed.data as Record<string, unknown>;
    expect(data.schemaName).toBe('extraction');
    expect(data.strict).toBe(false);
  }
});

test('rejects a schemaName the API would not accept', () => {
  expect(
    tool.config.inputSchema.safeParse({
      prompt: 'p',
      schema: personSchema,
      schemaName: 'has spaces',
    }).success,
  ).toBe(false);
});

test('rejects an empty prompt and a missing schema', () => {
  expect(
    tool.config.inputSchema.safeParse({
      prompt: '',
      schema: personSchema,
    }).success,
  ).toBe(false);
  expect(tool.config.inputSchema.safeParse({prompt: 'p'}).success).toBe(false);
});

test('a schema whose property is named $ref validates end to end', () => {
  /*
   * The gate rejects a node containing a `$ref` keyword. `$ref` is also a legal property NAME, and
   * inside `properties` it is caller-chosen data rather than a keyword — so this schema must reach
   * the API and validate normally. It is here as an end-to-end guard because the gate and the
   * compile and the response check all have to agree that this is an ordinary property.
   */
  const schema = {
    type: 'object',
    properties: {
      $ref: {type: 'string'},
      name: {type: 'string'},
    },
    required: ['$ref', 'name'],
  };
  const client = fakeClient('{"$ref":"a plain string","name":"Ada"}');

  return tool
    .handler(
      {
        prompt: 'p',
        schema,
        schemaName: 'extraction',
        strict: false,
      },
      {client},
    )
    .then((result) => {
      expect((result as {data: unknown}).data).toEqual({
        $ref: 'a plain string',
        name: 'Ada',
      });
    });
});

test('a real $ref is still rejected before the API call, even beside a property named $ref', async () => {
  const schema = {
    type: 'object',
    properties: {
      $ref: {type: 'string'},
      manager: {$ref: '#/$defs/person'},
    },
  };

  await expect(
    tool.handler(
      {
        prompt: 'p',
        schema,
        schemaName: 'extraction',
        strict: false,
      },
      {client: neverCalledClient()},
    ),
  ).rejects.toBeInstanceOf(SchemaError);
});
