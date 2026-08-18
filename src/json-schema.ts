import {sentence} from './text';

/**
 * Rejects the two JSON Schema constructs whose cost is not bounded by the size of the document.
 *
 * `mistral_extract` hands a caller-supplied schema to `z.fromJSONSchema` and validates the model's
 * response with what comes back. For almost every schema both steps cost roughly what the document
 * size suggests — a 300 KB schema compiles in a few milliseconds, and nesting, `allOf`, `anyOf`,
 * `patternProperties` and the rest all scale linearly. Two constructs break that, and both let a
 * schema of a few hundred bytes run for minutes:
 *
 * 1. **`$ref`.** A reference lets a small document describe a large or infinite structure. A cycle
 *    that never descends through `properties` or `items` produces a validator that recurses without
 *    consuming input, so it never returns at all.
 * 2. **An array-valued `type` on a node that has subschemas under it.** Zod converts that node's
 *    children once per entry in the array, so the work doubles at every level while the document
 *    grows by a few characters per level. Measured: `{"type":["object","object"],"properties":…}`
 *    nested 18 deep is 881 bytes and takes 3.5 seconds.
 *
 * An array-valued `type` on a LEAF is fine and stays allowed, because there are no children to
 * re-convert — `{"type": ["string", "null"]}` is the ordinary way to say a field is nullable, and it
 * compiles in well under a millisecond however deeply it is nested.
 *
 * With both rejected the remaining cost is proportional to the schema's size, which the transport
 * already bounds. A schema deep enough to exhaust the stack throws `RangeError`, which is catchable
 * — unlike a hang, which is not.
 */

/** A reason a schema cannot be used, phrased for the model that supplied it. */
export interface SchemaDefect {
  /** JSON Pointer to the offending node, so the message can say where. */
  at: string;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 6901 token escaping, so a property named `a/b` cannot look like a nested path. */
function escapeToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * Keywords whose value is a MAP of subschemas keyed by name, so the value itself is a container and
 * not a schema. The distinction matters: treating `properties` as a schema would make a property
 * legitimately named `$ref` look like a reference.
 */
const SUBSCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];

/**
 * Keywords whose value is a subschema, or an array of them. Which one it is varies by draft —
 * `items` is a single schema in 2020-12 and a tuple in draft-07 — so both are handled by shape
 * rather than by keyword.
 */
const SUBSCHEMA_VALUES = [
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'items',
  'additionalItems',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
];

/** Every keyword that puts subschemas under a node — the ones an array-valued `type` multiplies. */
const SUBSCHEMA_KEYWORDS = [...SUBSCHEMA_MAPS, ...SUBSCHEMA_VALUES];

/** Every child node of `schema`, paired with its pointer. */
function children(schema: Record<string, unknown>, at: string): Array<[unknown, string]> {
  const found: Array<[unknown, string]> = [];

  for (const keyword of SUBSCHEMA_MAPS) {
    const value = schema[keyword];
    if (isRecord(value)) {
      // The container is stepped over, never queued: its keys are property names, not keywords.
      for (const [key, entry] of Object.entries(value)) {
        found.push([entry, `${at}/${escapeToken(keyword)}/${escapeToken(key)}`]);
      }
    }
  }
  for (const keyword of SUBSCHEMA_VALUES) {
    const value = schema[keyword];
    if (!value) {
      continue;
    }
    const base = `${at}/${escapeToken(keyword)}`;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => found.push([entry, `${base}/${index}`]));
    } else {
      found.push([value, base]);
    }
  }
  return found;
}

/**
 * Walks the schema and returns the first defect, or `undefined` if it is safe to compile.
 *
 * Iterative rather than recursive: the input is caller-supplied and can be deeper than the stack,
 * and a checker that overflows on the schema it is meant to be vetting would be self-defeating.
 * `seen` also makes a schema object that references itself in memory terminate — `JSON.parse` never
 * produces one, but this function is exported and callable with a hand-built object.
 */
export function findSchemaDefect(schema: unknown): SchemaDefect | undefined {
  const queue: Array<[unknown, string]> = [[schema, '#']];
  const seen = new Set<unknown>();

  while (queue.length) {
    const next = queue.shift();
    if (!next) {
      break;
    }
    const [node, at] = next;
    if (!isRecord(node) || seen.has(node)) {
      continue;
    }
    seen.add(node);

    if ('$ref' in node) {
      return {
        at,
        reason: sentence`
          it uses \`$ref\`, which is not supported. Inline the referenced definition instead. A
          recursive shape cannot be written without \`$ref\`, so recursive schemas are not supported
          at all.
        `,
      };
    }

    if (Array.isArray(node.type) && SUBSCHEMA_KEYWORDS.some((keyword) => node[keyword])) {
      return {
        at,
        reason: sentence`
          it has an array-valued \`type\` on a node that also has subschemas under it, which makes
          the schema exponentially expensive to compile. Give this node a single \`type\`. An
          array-valued \`type\` is fine on a node with no subschemas, such as
          \`{"type": ["string", "null"]}\`.
        `,
      };
    }

    queue.push(...children(node, at));
  }

  return undefined;
}
