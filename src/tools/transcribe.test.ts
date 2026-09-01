import {test, expect, beforeAll, afterAll} from 'bun:test';
import {mkdtemp, rm, writeFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import tool from './transcribe';
import {AudioError} from '../errors';
import type {MistralClient, TranscribeRequest} from '../mistral-client';

function fakeClient(onTranscribe?: (request: TranscribeRequest) => void): MistralClient {
  return {
    transcribe: async (request: TranscribeRequest) => {
      onTranscribe?.(request);
      return {
        text: 'hello there',
        model: 'voxtral-mini-latest',
        language: 'en',
        segments: [
          {
            text: 'hello there',
            start: 0,
            end: 1.5,
            speakerId: 'speaker_0',
          },
        ],
        usage: {
          promptTokens: 1,
          completionTokens: 2,
          totalTokens: 3,
          audioSeconds: 2,
        },
      };
    },
  } as unknown as MistralClient;
}

let root: string;
let audioPath: string;

beforeAll(async () => {
  // Resolved for the same reason as in audio.test.ts: macOS `tmpdir()` is a symlink.
  root = await realpath(await mkdtemp(join(tmpdir(), 'transcribe-tool-')));
  audioPath = join(root, 'memo.wav');
  await writeFile(audioPath, 'riff-ish');
});

afterAll(async () => {
  await rm(root, {
    recursive: true,
    force: true,
  });
});

const audio = () => ({
  roots: [root],
  maxBytes: 1_000,
});

function parse(input: unknown) {
  return tool.config.inputSchema.safeParse(input);
}

test('is named mistral_transcribe and is not marked read-only', () => {
  expect(tool.name).toBe('mistral_transcribe');
  expect(tool.config.annotations.readOnlyHint).toBe(false);
  expect(tool.config.annotations.idempotentHint).toBe(false);
});

test('returns the transcript, language, segments and usage', async () => {
  const result = (await tool.handler(
    {
      fileUrl: 'https://example.com/a.mp3',
      diarize: false,
    },
    {client: fakeClient()},
  )) as Record<string, unknown>;

  expect(result.text).toBe('hello there');
  expect(result.model).toBe('voxtral-mini-latest');
  expect(result.language).toBe('en');
  expect(result.segments).toEqual([
    {
      text: 'hello there',
      start: 0,
      end: 1.5,
      speakerId: 'speaker_0',
    },
  ]);
  expect(result.usage).toEqual({
    promptTokens: 1,
    completionTokens: 2,
    totalTokens: 3,
    audioSeconds: 2,
  });
});

test('sends a url source through untouched', async () => {
  let seen: TranscribeRequest | undefined;
  await tool.handler(
    {
      fileUrl: 'https://example.com/a.mp3',
      diarize: false,
    },
    {
      client: fakeClient((request) => {
        seen = request;
      }),
    },
  );
  expect(seen?.audio).toEqual({
    kind: 'url',
    url: 'https://example.com/a.mp3',
  });
});

test('reads a permitted local path and sends its bytes', async () => {
  let seen: TranscribeRequest | undefined;
  await tool.handler(
    {
      filePath: audioPath,
      diarize: false,
    },
    {
      client: fakeClient((request) => {
        seen = request;
      }),
      audio: audio(),
    },
  );

  expect(seen?.audio.kind).toBe('file');
  if (seen?.audio.kind !== 'file') {
    throw new Error('expected a file source');
  }
  expect(seen.audio.fileName).toBe('memo.wav');
  expect(new TextDecoder().decode(seen.audio.content)).toBe('riff-ish');
});

test('forwards every optional parameter it was given', async () => {
  let seen: TranscribeRequest | undefined;
  await tool.handler(
    {
      fileUrl: 'https://example.com/a.mp3',
      language: 'fr',
      model: 'voxtral-mini-latest',
      temperature: 0,
      diarize: true,
      contextBias: ['Voxtral', 'Mistral'],
      timestampGranularities: ['segment', 'word'],
    },
    {
      client: fakeClient((request) => {
        seen = request;
      }),
    },
  );

  expect(seen?.language).toBe('fr');
  expect(seen?.model).toBe('voxtral-mini-latest');
  expect(seen?.temperature).toBe(0);
  expect(seen?.diarize).toBe(true);
  expect(seen?.contextBias).toEqual(['Voxtral', 'Mistral']);
  expect(seen?.timestampGranularities).toEqual(['segment', 'word']);
});

test('refuses a local path when deps carry no audio config, without calling the API', async () => {
  let called = false;
  const error = await tool
    .handler(
      {
        filePath: audioPath,
        diarize: false,
      },
      {
        client: fakeClient(() => {
          called = true;
        }),
      },
    )
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(AudioError);
  expect(called).toBe(false);
});

test('refuses an out-of-bounds path before spending a call', async () => {
  let called = false;
  const error = await tool
    .handler(
      {
        filePath: '/etc/passwd',
        diarize: false,
      },
      {
        client: fakeClient(() => {
          called = true;
        }),
        audio: audio(),
      },
    )
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(AudioError);
  expect(called).toBe(false);
});

test('requires exactly one audio source', () => {
  expect(parse({}).success).toBe(false);
  expect(
    parse({
      filePath: '/tmp/a.mp3',
      fileUrl: 'https://example.com/a.mp3',
    }).success,
  ).toBe(false);
  expect(parse({filePath: '/tmp/a.mp3'}).success).toBe(true);
  expect(parse({fileUrl: 'https://example.com/a.mp3'}).success).toBe(true);
});

test('rejects a fileUrl that is not a URL', () => {
  expect(parse({fileUrl: 'not-a-url'}).success).toBe(false);
});

test('rejects a model outside the transcription enum', () => {
  expect(
    parse({
      fileUrl: 'https://example.com/a.mp3',
      model: 'mistral-large-latest',
    }).success,
  ).toBe(false);
});

test('rejects a timestamp granularity outside segment and word', () => {
  expect(
    parse({
      fileUrl: 'https://example.com/a.mp3',
      timestampGranularities: ['sentence'],
    }).success,
  ).toBe(false);
});

test('rejects more than 100 context-bias terms', () => {
  const terms = Array.from({length: 101}, (_, index) => `term-${index}`);
  expect(
    parse({
      fileUrl: 'https://example.com/a.mp3',
      contextBias: terms,
    }).success,
  ).toBe(false);
  expect(
    parse({
      fileUrl: 'https://example.com/a.mp3',
      contextBias: terms.slice(0, 100),
    }).success,
  ).toBe(true);
});

test('defaults diarize to false', () => {
  const parsed = parse({fileUrl: 'https://example.com/a.mp3'});
  expect(parsed.success).toBe(true);
  expect(parsed.success && (parsed.data as {diarize: boolean}).diarize).toBe(false);
});
