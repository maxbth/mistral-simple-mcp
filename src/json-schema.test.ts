import {test, expect} from 'bun:test';
import {findSchemaDefect} from './json-schema';

/*
 * `findSchemaDefect` rejects exactly two constructs — see json-schema.ts for the measurements
 * that justify them — and has no opinion on anything else. Most of what matters here is the
 * boundary of that "nothing else": an array-valued `type` on a LEAF looks almost exactly like the
 * rejected pattern but must keep compiling, because it is the ordinary way to write a nullable
 * field. Its acceptance is tested more than the rejection is, on purpose.
 */

const refPositions: Array<{
  label: string;
  schema: Record<string, unknown>;
  at: string;
}> = [
  {
    label: 'at the root',
    schema: {$ref: '#/whatever'},
    at: '#',
  },
  {
    label: 'inside properties',
    schema: {properties: {manager: {$ref: '#/whatever'}}},
    at: '#/properties/manager',
  },
  {
    label: 'inside $defs',
    schema: {$defs: {node: {$ref: '#/whatever'}}},
    at: '#/$defs/node',
  },
  {
    label: 'inside items',
    schema: {items: {$ref: '#/whatever'}},
    at: '#/items',
  },
  {
    label: 'inside allOf',
    schema: {allOf: [{$ref: '#/whatever'}]},
    at: '#/allOf/0',
  },
];

for (const {label, schema, at} of refPositions) {
  test(`rejects a $ref ${label}, pointing at the node that carries it`, () => {
    const defect = findSchemaDefect(schema);
    expect(defect?.at).toBe(at);
    expect(defect?.reason).toContain('`$ref`');
  });
}

const arrayTypeWithSubschema: Array<{
  label: string;
  schema: Record<string, unknown>;
}> = [
  {
    label: 'properties',
    schema: {
      type: ['object', 'object'],
      properties: {a: {type: 'string'}},
    },
  },
  {
    label: 'items',
    schema: {
      type: ['array', 'array'],
      items: {type: 'string'},
    },
  },
  {
    label: 'allOf',
    schema: {
      type: ['object', 'object'],
      allOf: [{type: 'object'}],
    },
  },
];

for (const {label, schema} of arrayTypeWithSubschema) {
  test(`rejects an array-valued type on a node that also has ${label}`, () => {
    const defect = findSchemaDefect(schema);
    expect(defect).toBeDefined();
    expect(defect?.reason).toContain('array-valued `type`');
  });
}

/*
 * The regression that matters most. An array-valued `type` on a leaf — no `properties`, `items`
 * or any other subschema keyword beside it — has no children for Zod to re-convert, so it stays
 * cheap however deeply it is nested, and it is the standard way to spell "this field is
 * nullable". A tightening of the rule above that did not carve this out would break every
 * nullable field in every schema this server is ever handed.
 */
test('accepts an array-valued type on a standalone leaf', () => {
  expect(findSchemaDefect({type: ['string', 'null']})).toBeUndefined();
});

test('accepts an array-valued type on a leaf that is a property of an object', () => {
  expect(
    findSchemaDefect({
      type: 'object',
      properties: {nickname: {type: ['string', 'null']}},
      required: ['nickname'],
    }),
  ).toBeUndefined();
});

// Nested 24 deep is the exact depth json-schema.ts documents as compiling in 0.5ms.
test('accepts an array-valued type on a leaf nested 24 levels deep', () => {
  expect(findSchemaDefect(nestedObject(24, {type: ['string', 'null']}))).toBeUndefined();
});

test('accepts a flat object schema', () => {
  expect(
    findSchemaDefect({
      type: 'object',
      properties: {
        name: {type: 'string'},
        age: {type: 'integer'},
      },
      required: ['name'],
    }),
  ).toBeUndefined();
});

test('accepts a nested object schema', () => {
  expect(
    findSchemaDefect({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            city: {type: 'string'},
            zip: {type: 'string'},
          },
          required: ['city'],
        },
      },
    }),
  ).toBeUndefined();
});

test('accepts an array schema', () => {
  expect(
    findSchemaDefect({
      type: 'array',
      items: {type: 'string'},
    }),
  ).toBeUndefined();
});

test('accepts allOf, anyOf and oneOf schemas', () => {
  expect(
    findSchemaDefect({
      allOf: [
        {
          type: 'object',
          properties: {a: {type: 'string'}},
        },
        {
          type: 'object',
          properties: {b: {type: 'number'}},
        },
      ],
    }),
  ).toBeUndefined();
  expect(findSchemaDefect({anyOf: [{type: 'string'}, {type: 'number'}]})).toBeUndefined();
  expect(findSchemaDefect({oneOf: [{type: 'string'}, {type: 'number'}]})).toBeUndefined();
});

test('accepts patternProperties', () => {
  expect(
    findSchemaDefect({
      type: 'object',
      patternProperties: {'^S_': {type: 'string'}},
    }),
  ).toBeUndefined();
});

test('accepts an enum', () => {
  expect(
    findSchemaDefect({
      type: 'string',
      enum: ['a', 'b', 'c'],
    }),
  ).toBeUndefined();
});

test('returns undefined for non-object input rather than throwing', () => {
  expect(findSchemaDefect(null)).toBeUndefined();
  expect(findSchemaDefect('a string')).toBeUndefined();
  expect(findSchemaDefect(42)).toBeUndefined();
  expect(findSchemaDefect([1, 2, 3])).toBeUndefined();
});

/*
 * `JSON.parse` never produces an object that references itself, but this function is exported and
 * callable with a hand-built one. Without the `seen` set this loops forever; with it, the second
 * visit to `a` finds nothing new and the walk ends.
 */
test('terminates on an object that references itself in memory', () => {
  const a: Record<string, unknown> = {type: 'object'};
  a.properties = {a};
  expect(findSchemaDefect(a)).toBeUndefined();
});

/*
 * The walk has to be iterative rather than recursive: the input is caller-supplied and can be
 * deeper than the stack, and a checker that overflows on the schema it is meant to be vetting
 * would be self-defeating.
 */
test('walks a 5000-level-deep schema without a stack overflow', () => {
  expect(findSchemaDefect(nestedObject(5_000, {type: 'string'}))).toBeUndefined();
});

/*
 * The regression this guards against: `{"type":["object","object"],"properties":{...}}` nested 18
 * deep is 881 bytes and takes z.fromJSONSchema 3.5 SECONDS to compile (measured on Zod 4.4.3). If
 * the array-type rule were ever removed from `findSchemaDefect`, this exact shape would sail
 * through unnoticed, reach `z.fromJSONSchema` — here in the test suite as much as in
 * `mistral_extract` itself — and hang. So it is built and rejected, never compiled: catching it
 * here is what turns that regression into an obvious, fast test failure instead of a suite that
 * quietly starts taking seconds.
 */
test('rejects a depth-18 type-array fan-out well under 100ms, without compiling it', () => {
  const started = Date.now();
  const defect = findSchemaDefect(typeArrayFanOut(18));
  const elapsed = Date.now() - started;

  expect(defect).toBeDefined();
  expect(elapsed).toBeLessThan(100);
});

/** Wraps `leaf` in `depth` levels of `{type: 'object', properties: {child: ...}}`. */
function nestedObject(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let node = leaf;
  for (let level = 0; level < depth; level += 1) {
    node = {
      type: 'object',
      properties: {child: node},
    };
  }
  return node;
}

/**
 * `{"type":["object","object"],"properties":{"child":...}}` nested `depth` deep — the shape
 * documented in json-schema.ts as costing z.fromJSONSchema 3.5 seconds to compile at depth 18.
 * Built with a loop so constructing it does not itself recurse.
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

/*
 * A keyword like `properties` holds a MAP of subschemas, so its keys are names chosen by the
 * caller — and one of those names can be `$ref`. An earlier version of the walk queued the map
 * object itself as if it were a schema, on the reasoning that visiting a non-schema node would
 * "cost one iteration and find nothing". That reasoning was wrong for exactly this input: the map
 * `{$ref: {...}}` has an own key `$ref`, which is indistinguishable from a real reference once the
 * node is being checked. The map is now stepped over rather than queued.
 */
test('a property named $ref is a property name, not a reference', () => {
  expect(
    findSchemaDefect({
      type: 'object',
      properties: {$ref: {type: 'string'}},
      required: ['$ref'],
    }),
  ).toBeUndefined();
});

test('a $defs entry named $ref is a definition name, not a reference', () => {
  expect(
    findSchemaDefect({
      $defs: {$ref: {type: 'string'}},
      type: 'object',
      properties: {a: {type: 'string'}},
    }),
  ).toBeUndefined();
});

test('the same holds for every keyword whose value is a map of subschemas', () => {
  // Each of these puts a keyword's own name in a position where it is caller-chosen data.
  expect(
    findSchemaDefect({
      type: 'object',
      patternProperties: {'^\\$ref$': {type: 'string'}},
    }),
  ).toBeUndefined();
  expect(
    findSchemaDefect({
      type: 'object',
      properties: {$defs: {type: 'string'}},
    }),
  ).toBeUndefined();
  expect(
    findSchemaDefect({
      type: 'object',
      properties: {properties: {type: 'string'}},
    }),
  ).toBeUndefined();
  expect(
    findSchemaDefect({
      definitions: {$ref: {type: 'string'}},
      type: 'object',
    }),
  ).toBeUndefined();
});

test('a real $ref alongside a property named $ref is still rejected', () => {
  // The property name must not shadow the genuine reference sitting next to it.
  expect(
    findSchemaDefect({
      type: 'object',
      properties: {
        $ref: {type: 'string'},
        real: {$ref: '#/$defs/x'},
      },
    }),
  ).toEqual({
    at: '#/properties/real',
    reason: expect.stringContaining('$ref'),
  });
});
