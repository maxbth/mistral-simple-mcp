import {test, expect} from 'bun:test';
import {PublicError, MistralError, SchemaError} from './errors';

test('MistralError is a PublicError and carries a status', () => {
  const error = new MistralError('rate limited', 429);
  expect(error).toBeInstanceOf(PublicError);
  expect(error).toBeInstanceOf(Error);
  expect(error.status).toBe(429);
  expect(error.message).toBe('rate limited');
  expect(error.name).toBe('MistralError');
});

test('MistralError status is optional', () => {
  expect(new MistralError('no response').status).toBeUndefined();
});

test('SchemaError is a PublicError', () => {
  const error = new SchemaError('bad schema');
  expect(error).toBeInstanceOf(PublicError);
  expect(error.name).toBe('SchemaError');
});

test('a plain Error is not a PublicError', () => {
  expect(new Error('boom')).not.toBeInstanceOf(PublicError);
});
