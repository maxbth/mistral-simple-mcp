import {test, expect} from 'bun:test';
import {textFromContent} from './content';

test('returns a plain string unchanged', () => {
  expect(textFromContent('hello')).toBe('hello');
});

test('returns an empty string unchanged rather than treating it as absent', () => {
  expect(textFromContent('')).toBe('');
});

test('concatenates text chunks in order', () => {
  expect(
    textFromContent([
      {
        type: 'text',
        text: 'one ',
      },
      {
        type: 'text',
        text: 'two',
      },
    ]),
  ).toBe('one two');
});

test('drops non-text chunks, which carry no completion text', () => {
  expect(
    textFromContent([
      {
        type: 'thinking',
        thinking: [],
      },
      {
        type: 'text',
        text: 'answer',
      },
      {
        type: 'image_url',
        imageUrl: 'https://example.com/a.png',
      },
    ]),
  ).toBe('answer');
});

test('returns undefined for null, undefined, and a chunk list with no text', () => {
  expect(textFromContent(null)).toBeUndefined();
  expect(textFromContent(undefined)).toBeUndefined();
  expect(
    textFromContent([
      {
        type: 'image_url',
        imageUrl: 'https://example.com/a.png',
      },
    ]),
  ).toBeUndefined();
  expect(textFromContent([])).toBeUndefined();
});
