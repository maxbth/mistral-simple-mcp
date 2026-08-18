import {z} from 'zod';
import {defineTool, CALLS_A_PAID_API_ANNOTATION} from './types';
import {modelSchema} from '../models';
import {sentence} from '../text';

const inputSchema = z.object({
  prompt: z.string().min(1).describe('The instruction and any input text it operates on.'),
  system: z.string().min(1).optional().describe('System prompt setting the role, tone or output rules.'),
  model: modelSchema.optional().describe('Model to use. Defaults to the server-configured model.'),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe('Sampling temperature. Lower is more deterministic. Mistral recommends 0.0-0.7.'),
  maxTokens: z.number().int().positive().optional().describe('Maximum tokens to generate.'),
});

export default defineTool({
  name: 'mistral_complete',
  config: {
    title: 'Mistral text completion',
    description: sentence`
      Generate text with a Mistral model. Use this to delegate a self-contained subtask —
      summarizing, rewriting, classifying, drafting — to a separate model. Send the whole input in
      \`prompt\`; this is a single-shot call that keeps no conversation state between invocations.
      For output that must match a specific JSON shape, use mistral_extract instead.
    `,
    inputSchema,
    annotations: CALLS_A_PAID_API_ANNOTATION,
  },
  handler: async (input, {client}) => {
    const result = await client.complete({
      prompt: input.prompt,
      system: input.system,
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    });

    return {
      text: result.text,
      model: result.model,
      finishReason: result.finishReason,
      usage: result.usage,
    };
  },
});
