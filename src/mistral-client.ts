import {Mistral} from '@mistralai/mistralai';
// Namespaced deliberately: the SDK exports its own `MistralError`, and a bare named import
// would silently shadow ours in the mapping below.
import * as sdkErrors from '@mistralai/mistralai/models/errors';
import type {ResponseFormat} from '@mistralai/mistralai/models/components';
import {MistralError} from './errors';
import {textFromContent} from './content';
import type {MistralConfig} from './config';
import type {Model} from './models';
import {sentence} from './text';

/**
 * Error `code` values that mean the request never reached a server.
 *
 * The SDK has its own `isConnectionError` heuristic, but on Bun it only recognises
 * `err.name === 'ConnectionError'` (`lib/http.ts`), and Bun's own failures carry `name: 'Error'`
 * with the detail in `code` — measured as `ConnectionRefused` for a closed port and
 * `FailedToOpenSocket` for a name that does not resolve. So the SDK wraps both in
 * `UnexpectedClientError`, its own `ConnectionError` never gets constructed, and an operator who
 * typos `MISTRAL_BASE_URL` gets a generic failure with no host in it. The Node/libuv spellings are
 * listed alongside Bun's so this keeps working if the server is ever run on another runtime.
 */
const CONNECTION_FAILURE_CODES = new Set([
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
]);

/** Error `name` values with the same meaning, for runtimes that report it there instead. */
const CONNECTION_FAILURE_NAMES = new Set(['ConnectionError', 'DNSException']);

/**
 * Reports whether an error, or anything in its `cause` chain, identifies itself as a failure to
 * reach the server at all.
 *
 * ONLY `code` and `name` are read. `message` is deliberately never inspected, matched against or
 * forwarded: `HTTPClientError` appends the wrapped error to its own message and an SDK HTTP error
 * appends the response body, and a response body has been observed carrying the API key verbatim.
 * A message-based heuristic here would be one refactor away from leaking it.
 *
 * The depth limit is what keeps a self-referential `cause` chain from spinning.
 */
function isConnectionFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== 'object') {
      return false;
    }
    const code = (current as {code?: unknown}).code;
    if (typeof code === 'string' && CONNECTION_FAILURE_CODES.has(code)) {
      return true;
    }
    const name = (current as {name?: unknown}).name;
    if (typeof name === 'string' && CONNECTION_FAILURE_NAMES.has(name)) {
      return true;
    }
    current = (current as {cause?: unknown}).cause;
  }
  return false;
}

export interface CompleteRequest {
  prompt: string;
  system?: string;
  model?: Model;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
}

export interface CompleteResult {
  text: string;
  model: string;
  finishReason: string;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * The only module that imports the Mistral SDK.
 *
 * Everything above it sees `complete()` and the plain shapes above, which is what lets tools be
 * tested against a two-line fake instead of a mocked HTTP layer. Timeout and retry are SDK
 * options rather than hand-rolled `AbortSignal` plumbing, because the SDK already applies both
 * per request and counts a retry against the same budget.
 */
export class MistralClient {
  private readonly mistral: Mistral;
  private readonly config: MistralConfig;

  constructor(config: MistralConfig) {
    this.config = config;
    this.mistral = new Mistral({
      apiKey: config.apiKey,
      serverURL: config.baseUrl,
      timeoutMs: config.timeoutMs,
      /*
       * The SDK expresses retries purely as a backoff shape — there is no attempt count, which
       * is why no `MISTRAL_MAX_RETRIES` setting exists. Both numbers are derived from the request
       * timeout so that a retry sequence can never outlive the deadline the caller was promised.
       *
       * The retry budget is deliberately STRICTLY smaller than that deadline, not equal to it.
       * The SDK arms one `AbortSignal.timeout(timeoutMs)` for the whole sequence, and its retry
       * loop only hands back the real response once its own budget is spent (`lib/retries.ts`:
       * `if (elapsed > maxElapsedTime) { return err.response }`). With the two set equal the abort
       * always won that race, the response never surfaced, and every retryable status came back as
       * a timeout — which made the 429 and 5xx mappings in `toMistralError` unreachable.
       *
       * The backoff cap is scaled for the same reason. The loop only checks its budget after an
       * attempt, so a cap that is large next to the deadline can push the attempt that would have
       * ended the sequence past it — measured flaky at a 1s timeout with the SDK's own 10s cap.
       * 0.8 and 0.1 leave room for the budget to expire, one more attempt to run, and its status
       * to be mapped, all inside the deadline.
       */
      retryConfig: {
        strategy: 'backoff',
        backoff: {
          initialInterval: 500,
          maxInterval: Math.min(10_000, Math.floor(config.timeoutMs * 0.1)),
          exponent: 1.5,
          maxElapsedTime: Math.floor(config.timeoutMs * 0.8),
        },
        retryConnectionErrors: true,
      },
    });
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const messages: Array<{
      role: 'system' | 'user';
      content: string;
    }> = [];
    if (request.system) {
      messages.push({
        role: 'system',
        content: request.system,
      });
    }
    messages.push({
      role: 'user',
      content: request.prompt,
    });

    let response;
    try {
      response = await this.mistral.chat.complete({
        model: request.model ?? this.config.model,
        messages,
        // Spread rather than assigning `undefined`: the SDK serialises an explicit `undefined`
        // for some fields, and the API rejects a null temperature outright.
        //
        // These stay `=== undefined` rather than becoming truthy checks: `temperature: 0` is both
        // valid and falsy, and a truthy test would silently drop it.
        ...(request.temperature === undefined ? {} : {temperature: request.temperature}),
        ...(request.maxTokens === undefined ? {} : {maxTokens: request.maxTokens}),
        ...(request.responseFormat === undefined ? {} : {responseFormat: request.responseFormat}),
      });
    } catch (error) {
      throw this.toMistralError(error);
    }

    const choice = response.choices[0];
    if (!choice) {
      throw new MistralError('Mistral returned no completion choices. Retry, or try a different model.');
    }

    // `=== undefined` deliberately, not `!text`: `content.ts` distinguishes `''` — the model
    // returned an empty completion — from no content at all, and only the latter is an error.
    const text = textFromContent(choice.message?.content);
    if (text === undefined) {
      throw new MistralError(sentence`
        Mistral returned a choice with no text content (finish reason:
        ${String(choice.finishReason)}). Retry, or shorten the prompt.
      `);
    }

    return {
      text,
      model: response.model,
      finishReason: String(choice.finishReason),
      usage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
      },
    };
  }

  /**
   * Maps a transport failure onto a message that says what to do about it.
   *
   * The fallback deliberately discards the original message rather than appending it: an
   * unrecognised throw can carry a request URL with the key in a query string, a resolved
   * internal IP, or a raw response body. None of that helps the model decide what to retry.
   */
  private toMistralError(error: unknown): MistralError {
    if (error instanceof MistralError) {
      return error;
    }
    if (error instanceof sdkErrors.ConnectionError) {
      return this.unreachableError();
    }
    if (error instanceof sdkErrors.RequestTimeoutError) {
      return new MistralError(sentence`
        Timed out after ${this.config.timeoutMs}ms waiting for Mistral. Shorten the prompt, use a
        smaller model, or raise MISTRAL_TIMEOUT_MS.
      `);
    }
    /*
     * `sdkErrors.MistralError` is the SDK's base class for every HTTP error response and carries
     * `statusCode`; `SDKError` and `HTTPValidationError` both extend it. Branching on the base
     * covers subclasses this code has never heard of, which is the point — a new error type in a
     * future SDK release still gets a status-aware message instead of the generic fallback.
     *
     * The SDK's own `message` is never forwarded: it appends the response body, which for a 4xx
     * routinely echoes the offending request. That can include the API key.
     */
    if (error instanceof sdkErrors.MistralError) {
      const status = error.statusCode;
      if (status === 401 || status === 403) {
        return new MistralError(`Mistral rejected the configured credentials (HTTP ${status}). Check MISTRAL_API_KEY.`, status);
      }
      if (status === 429) {
        return new MistralError('Mistral rate limit exceeded (HTTP 429). Wait and retry, or use a smaller model.', 429);
      }
      if (status === 422) {
        return new MistralError('Mistral rejected the request as invalid. Check the model, schema and sampling parameters.', 422);
      }
      /*
       * A success status reaching here means the SDK rejected the BODY, not the status:
       * `ResponseValidationError` extends the same base and takes its `statusCode` from the 200 it
       * was validating. Reporting that as "request failed: HTTP 200" says nothing a caller can act
       * on, so the shape is named instead.
       */
      if (status < 400) {
        return new MistralError(
          sentence`
            Mistral returned an HTTP ${status} whose body was not in the expected shape, so it could
            not be read. Retry; if it persists, the endpoint being called may not be a
            Mistral-compatible API.
          `,
          status,
        );
      }
      return new MistralError(`Mistral request failed: HTTP ${status}.`, status);
    }
    /*
     * Last, and only ever in place of the generic fallback: a runtime-specific connection failure
     * the SDK did not recognise as one. Kept below every `instanceof` branch on purpose, so it can
     * only ever improve an error that was otherwise going to say nothing at all — it cannot
     * reclassify a timeout or an HTTP status that one of those branches already understood.
     */
    if (isConnectionFailure(error)) {
      return this.unreachableError();
    }
    return new MistralError('Mistral request failed for an unrecognised reason.');
  }

  /** The "the request never got there" message, naming the host without its credentials. */
  private unreachableError(): MistralError {
    return new MistralError(sentence`
      Cannot reach the Mistral API at ${this.sanitizedBaseUrl()}. Check network access from this
      process${this.config.baseUrl ? ', and that MISTRAL_BASE_URL is correct' : ''}.
    `);
  }

  /**
   * Returns `config.baseUrl` reduced to a scheme+host safe to interpolate into an error message,
   * or the default API host when unset.
   *
   * An operator can point `MISTRAL_BASE_URL` at a gateway with credentials embedded in the URL
   * (`https://user:secret@gateway.internal/`), and that secret must not come back out through a
   * `PublicError` message. Clearing `username`/`password` before reading `origin` makes that
   * guarantee explicit at the call site rather than resting on `URL#origin` silently excluding
   * them; `origin` also drops any path or query string, which is the same class of leak this
   * file already guards against elsewhere. `baseUrl` is validated as a URL by config.ts before
   * it reaches here, but the parse is guarded anyway: throwing while building an error message
   * would trade the leak this exists to prevent for a crash, which is worse.
   */
  private sanitizedBaseUrl(): string {
    if (!this.config.baseUrl) {
      return 'https://api.mistral.ai';
    }
    try {
      const url = new URL(this.config.baseUrl);
      url.username = '';
      url.password = '';
      return url.origin;
    } catch {
      return 'the configured MISTRAL_BASE_URL';
    }
  }
}
