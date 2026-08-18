import {z} from 'zod';
import {defineTool, CALLS_A_PAID_API_ANNOTATION} from './types';
import {modelSchema} from '../models';
import {SchemaError} from '../errors';
import {findSchemaDefect} from '../json-schema';
import {sentence} from '../text';

const inputSchema = z.object({
  prompt: z.string().min(1).describe('The instruction and the text to extract from.'),
  schema: z.record(z.string(), z.unknown()).describe(sentence`
      JSON Schema describing the object to return. Standard JSON Schema: an object with \`type\`,
      \`properties\` and \`required\`, nested as deeply as you need. Two things are rejected
      before any model call, both because they make a small schema extremely expensive to compile:
      \`$ref\` in any form — inline the definition instead, and note that this means recursive
      shapes cannot be expressed — and an array-valued \`type\` on a node that also has subschemas
      under it, so give such a node a single \`type\`. An array-valued \`type\` is fine on a node
      with no subschemas, so \`{"type": ["string", "null"]}\` is the way to say a field is
      nullable. Constructs Zod cannot represent, such as if/then/else and not, are also rejected
      before any model call.
    `),
  schemaName: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'schemaName may contain only letters, digits, underscores and hyphens')
    .default('extraction')
    .describe('Name for the schema in the API request. Letters, digits, underscores and hyphens only.'),
  system: z.string().min(1).optional().describe('System prompt setting extraction rules.'),
  model: modelSchema.optional().describe('Model to use. Defaults to the server-configured model.'),
  temperature: z.number().min(0).max(2).optional().describe('Sampling temperature. Extraction usually wants a low value.'),
  strict: z.boolean().default(false).describe(sentence`
      Enable Mistral strict mode. Requires the schema to set \`additionalProperties: false\` on every
      object and list every property in \`required\`; Mistral rejects the request otherwise. Leave
      false unless the schema meets those conditions.
    `),
});

export default defineTool({
  name: 'mistral_extract',
  config: {
    title: 'Mistral structured extraction',
    description: sentence`
      Extract structured data matching a JSON Schema you supply. Returns an object validated against
      that schema, so a successful call always matches the shape requested. Use this instead of
      mistral_complete whenever the result is going to be read by code rather than a person.
      Optional properties are returned absent, not null.
    `,
    inputSchema,
    annotations: CALLS_A_PAID_API_ANNOTATION,
  },
  handler: async (input, {client}) => {
    /*
     * Compiling a caller-supplied schema is cheap and bounded, but only after two constructs are
     * refused: `$ref`, and an array-valued `type` on a node with subschemas under it. Either lets a
     * few hundred bytes cost minutes — see `json-schema.ts` for the measurements. Everything else
     * costs roughly what the document's size suggests, and the transport already bounds that.
     *
     * Refusing them here also means this happens BEFORE the paid request, so a schema this server
     * cannot use costs nothing.
     */
    const defect = findSchemaDefect(input.schema);
    if (defect) {
      throw new SchemaError(sentence`
        The \`schema\` argument cannot be used: ${defect.reason} The problem is at \`${defect.at}\`.
      `);
    }

    let validator: z.ZodType;
    try {
      validator = z.fromJSONSchema(input.schema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch (error) {
      // Zod's own message, which names the construct it cannot represent. Forwarded, not replaced.
      throw new SchemaError(sentence`
        The \`schema\` argument cannot be used: ${error instanceof Error ? error.message : 'it could not be compiled'}.
        Rewrite it using plain types, properties and required.
      `);
    }

    const result = await client.complete({
      prompt: input.prompt,
      system: input.system,
      model: input.model,
      temperature: input.temperature,
      responseFormat: {
        type: 'json_schema',
        jsonSchema: {
          name: input.schemaName,
          // Sent verbatim: the schema is not normalized, so an optional property stays optional and
          // comes back absent — which `validator`, built from this same schema, accepts.
          schemaDefinition: input.schema,
          strict: input.strict,
        },
      },
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      throw new SchemaError(sentence`
        Mistral returned text that is not valid JSON. Retry, lower the temperature, or simplify the
        schema. First 200 characters: ${result.text.slice(0, 200)}
      `);
    }

    /*
     * The real enforcement. The schema is not normalized, so `strict` defaults to false and
     * constrained decoding is not guaranteeing the shape — this is what holds the tool's contract.
     * The issue list is surfaced verbatim so a retry can be targeted.
     *
     * `safeParse` does not throw for a mismatch, but it does for a schema deep enough to exhaust the
     * stack against a deep enough response. Money has been spent by this point either way, so both
     * become a `SchemaError` the caller can act on.
     */
    let validated: z.ZodSafeParseResult<unknown>;
    try {
      validated = validator.safeParse(parsed);
    } catch (error) {
      throw new SchemaError(sentence`
        Mistral returned JSON that could not be checked against the schema
        (${error instanceof Error ? error.message : 'validation failed'}). The schema is probably too
        deeply nested. Flatten it and retry.
      `);
    }

    if (!validated.success) {
      const issues = validated.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
      throw new SchemaError(sentence`
        Mistral returned JSON that does not match the schema: ${issues}. Retry, or make the schema's
        descriptions more explicit.
      `);
    }

    return {
      data: validated.data,
      model: result.model,
      usage: result.usage,
    };
  },
});
