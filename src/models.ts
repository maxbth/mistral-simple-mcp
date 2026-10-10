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
export const MODELS = ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest', 'mistral-large-4-0'] as const;

export const DEFAULT_MODEL = 'mistral-medium-latest';

export const modelSchema = z.enum(MODELS);

/**
 * `high` returns a full thinking block ahead of the answer and costs more tokens; `none` keeps
 * thinking minimal and omits the block. Only some models honour it (see the README).
 */
export const REASONING_EFFORTS = ['none', 'high'] as const;

export const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export type Model = z.infer<typeof modelSchema>;
