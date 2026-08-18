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
