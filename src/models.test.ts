import {test, expect} from 'bun:test';
import {MODELS, DEFAULT_MODEL, modelSchema, TRANSCRIPTION_MODELS, DEFAULT_TRANSCRIPTION_MODEL, transcriptionModelSchema} from './models';

test('exposes exactly the three supported model ids', () => {
  expect(MODELS).toEqual(['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest']);
});

test('defaults to the medium model', () => {
  expect(DEFAULT_MODEL).toBe('mistral-medium-latest');
});

test('the default is itself a valid enum value', () => {
  expect(modelSchema.safeParse(DEFAULT_MODEL).success).toBe(true);
});

test('rejects a model id outside the enum', () => {
  expect(modelSchema.safeParse('mistral-tiny').success).toBe(false);
  expect(modelSchema.safeParse('gpt-4').success).toBe(false);
});

test('rejects a bare size alias, since values are full model ids', () => {
  expect(modelSchema.safeParse('medium').success).toBe(false);
});

test('exposes the transcription models as their own enum', () => {
  expect(TRANSCRIPTION_MODELS).toEqual(['voxtral-mini-latest']);
  expect(transcriptionModelSchema.safeParse(DEFAULT_TRANSCRIPTION_MODEL).success).toBe(true);
});

test('keeps the chat and transcription enums disjoint in both directions', () => {
  expect(modelSchema.safeParse(DEFAULT_TRANSCRIPTION_MODEL).success).toBe(false);
  expect(transcriptionModelSchema.safeParse(DEFAULT_MODEL).success).toBe(false);
});

test('rejects a Voxtral model that is not a transcribe model', () => {
  expect(transcriptionModelSchema.safeParse('voxtral-small-latest').success).toBe(false);
});
