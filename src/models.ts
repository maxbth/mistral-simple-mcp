import {z} from 'zod';

/**
 * The models this server exposes.
 *
 * The values ARE the model ids sent to the API, not aliases resolved through a lookup table —
 * so nothing can drift between what a caller names and what is dispatched. The `-latest`
 * suffixes absorb Mistral's periodic model renames without a code change here.
 *
 * A closed enum also makes an invalid model id unrepresentable: a call cannot fail on a
 * hallucinated model name, because the tool's input schema rejects it before the handler runs.
 */
export const MODELS = ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest'] as const;

export const DEFAULT_MODEL = 'mistral-medium-latest';

export const modelSchema = z.enum(MODELS);

export type Model = z.infer<typeof modelSchema>;

/**
 * The models this server exposes for offline (whole-file) transcription.
 *
 * Kept as its own closed enum rather than folded into `MODELS`: the two sets are not
 * interchangeable in either direction. A Voxtral transcribe model is not a chat model, and
 * sending `mistral-large-latest` to `/v1/audio/transcriptions` is a 422 — so a single enum would
 * make a request that cannot work representable, which is the exact thing `MODELS` exists to
 * prevent.
 *
 * Only the mini transcribe family is listed because it is the only family Mistral documents for
 * this endpoint; `voxtral-small-latest` is a chat-with-audio model, not a transcription one.
 */
export const TRANSCRIPTION_MODELS = ['voxtral-mini-latest'] as const;

export const DEFAULT_TRANSCRIPTION_MODEL = 'voxtral-mini-latest';

export const transcriptionModelSchema = z.enum(TRANSCRIPTION_MODELS);

export type TranscriptionModel = z.infer<typeof transcriptionModelSchema>;
