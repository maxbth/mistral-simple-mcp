import {test, expect} from 'bun:test';
import tool from './complete';
import type {MistralClient, CompleteRequest} from '../mistral-client';

function fakeClient(onComplete?: (request: CompleteRequest) => void): MistralClient {
  return {
    complete: async (request: CompleteRequest) => {
      onComplete?.(request);
      return {
        text: 'the answer',
        model: 'mistral-medium-latest',
        finishReason: 'stop',
        usage: {
          promptTokens: 12,
          completionTokens: 3,
          totalTokens: 15,
        },
      };
    },
  } as unknown as MistralClient;
}

test('is named mistral_complete and is not marked read-only', () => {
  expect(tool.name).toBe('mistral_complete');
  expect(tool.config.annotations.readOnlyHint).toBe(false);
  expect(tool.config.annotations.idempotentHint).toBe(false);
});

test('returns the text, resolved model and usage', async () => {
  const result = (await tool.handler({prompt: 'q'}, {client: fakeClient()})) as Record<string, unknown>;
  expect(result.text).toBe('the answer');
  expect(result.model).toBe('mistral-medium-latest');
  expect(result.usage).toEqual({
    promptTokens: 12,
    completionTokens: 3,
    totalTokens: 15,
  });
});

test('forwards every optional parameter it was given', async () => {
  let seen: CompleteRequest | undefined;
  await tool.handler(
    {
      prompt: 'q',
      system: 's',
      model: 'mistral-large-latest',
      temperature: 0.4,
      maxTokens: 50,
    },
    {
      client: fakeClient((request) => {
        seen = request;
      }),
    },
  );

  expect(seen?.prompt).toBe('q');
  expect(seen?.system).toBe('s');
  expect(seen?.model).toBe('mistral-large-latest');
  expect(seen?.temperature).toBe(0.4);
  expect(seen?.maxTokens).toBe(50);
});

test('rejects an empty prompt', () => {
  expect(tool.config.inputSchema.safeParse({prompt: ''}).success).toBe(false);
});

test('rejects a model outside the enum', () => {
  expect(
    tool.config.inputSchema.safeParse({
      prompt: 'q',
      model: 'gpt-4',
    }).success,
  ).toBe(false);
});

test('rejects an out-of-range temperature and a non-positive maxTokens', () => {
  expect(
    tool.config.inputSchema.safeParse({
      prompt: 'q',
      temperature: 2.5,
    }).success,
  ).toBe(false);
  expect(
    tool.config.inputSchema.safeParse({
      prompt: 'q',
      maxTokens: 0,
    }).success,
  ).toBe(false);
});

test('accepts a prompt on its own', () => {
  expect(tool.config.inputSchema.safeParse({prompt: 'q'}).success).toBe(true);
});
