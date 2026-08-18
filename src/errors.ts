/**
 * Base class for errors whose message is safe to return to the model.
 *
 * `server.ts` surfaces a `PublicError`'s message verbatim and replaces anything else with a
 * generic string, so this type is the boundary between "explains what the caller should do
 * differently" and "internal detail that must not leak". Every message on a subclass is written
 * to be read by an agent deciding what to retry.
 */
export class PublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicError';
  }
}

/** A failure talking to the Mistral API. `status` is the HTTP status when there was one. */
export class MistralError extends PublicError {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MistralError';
    this.status = status;
  }
}

/** The caller's JSON Schema was unusable, or the response did not satisfy it. */
export class SchemaError extends PublicError {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}
