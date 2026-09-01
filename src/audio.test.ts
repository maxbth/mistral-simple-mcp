import {test, expect, beforeAll, afterAll} from 'bun:test';
import {mkdtemp, mkdir, rm, symlink, writeFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readAudioFile} from './audio';
import {AudioError} from './errors';

/**
 * Every path in here is run through `realpath` before use.
 *
 * On macOS `os.tmpdir()` is `/var/folders/…`, which is itself a symlink into `/private/var`. A
 * root taken straight from `mkdtemp` would resolve to a different string than the file under it
 * does, and the containment test — which resolves both sides — would then fail for a reason that
 * has nothing to do with what is being tested.
 */
let root: string;
let outside: string;
let inside: string;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'audio-test-')));
  root = join(base, 'allowed');
  outside = join(base, 'forbidden');
  await mkdir(root);
  await mkdir(outside);
  inside = join(root, 'meeting.mp3');
  await writeFile(inside, 'fake-audio-bytes');
  await writeFile(join(outside, 'secret.txt'), 'not yours');
});

afterAll(async () => {
  await rm(join(root, '..'), {
    recursive: true,
    force: true,
  });
});

function config(overrides: Partial<Parameters<typeof readAudioFile>[1]> = {}) {
  return {
    roots: [root],
    maxBytes: 1_000,
    ...overrides,
  };
}

test('reads a file inside a configured root, keeping its basename', async () => {
  const file = await readAudioFile(inside, config());
  expect(file.fileName).toBe('meeting.mp3');
  expect(new TextDecoder().decode(file.content)).toBe('fake-audio-bytes');
});

test('refuses every local path when no roots are configured', async () => {
  const error = await readAudioFile(inside, config({roots: []})).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AudioError);
  expect((error as AudioError).message).toContain('MISTRAL_AUDIO_ROOTS is not set');
});

test('refuses a relative path rather than resolving it against the cwd', async () => {
  const error = await readAudioFile('meeting.mp3', config()).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AudioError);
  expect((error as AudioError).message).toContain('absolute path');
});

test('refuses a path outside every root', async () => {
  const error = await readAudioFile(join(outside, 'secret.txt'), config()).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AudioError);
  expect((error as AudioError).message).toContain('MISTRAL_AUDIO_ROOTS');
});

test('refuses a traversal that climbs back out of a root', async () => {
  const error = await readAudioFile(join(root, '..', 'forbidden', 'secret.txt'), config()).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AudioError);
});

test('refuses a symlink inside a root that points outside it', async () => {
  const link = join(root, 'escape.mp3');
  await symlink(join(outside, 'secret.txt'), link);
  try {
    const error = await readAudioFile(link, config()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AudioError);
    expect((error as AudioError).message).toContain('not permitted');
  } finally {
    await rm(link);
  }
});

test('follows a symlink that stays inside a root', async () => {
  const link = join(root, 'alias.mp3');
  await symlink(inside, link);
  try {
    const file = await readAudioFile(link, config());
    // The RESOLVED basename, because the resolved path is what gets read.
    expect(file.fileName).toBe('meeting.mp3');
  } finally {
    await rm(link);
  }
});

test('does not let a sibling directory sharing a root prefix pass as contained', async () => {
  const sibling = `${root}-extra`;
  await mkdir(sibling);
  const smuggled = join(sibling, 'secret.mp3');
  await writeFile(smuggled, 'nope');
  try {
    const error = await readAudioFile(smuggled, config()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AudioError);
  } finally {
    await rm(sibling, {
      recursive: true,
      force: true,
    });
  }
});

test('accepts a file under any one of several roots', async () => {
  const file = await readAudioFile(inside, config({roots: [outside, root]}));
  expect(file.fileName).toBe('meeting.mp3');
});

test('skips a root that does not exist instead of failing the whole call', async () => {
  const file = await readAudioFile(inside, config({roots: [join(root, 'nope'), root]}));
  expect(file.fileName).toBe('meeting.mp3');
});

test('reports a missing file without naming a resolved path', async () => {
  const missing = join(root, 'absent.mp3');
  const error = await readAudioFile(missing, config()).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AudioError);
  expect((error as AudioError).message).toContain('No readable file');
  expect((error as AudioError).message).toContain(missing);
});

test('refuses a directory', async () => {
  const error = await readAudioFile(root, config()).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AudioError);
  expect((error as AudioError).message).toContain('not a regular file');
});

test('refuses an empty file', async () => {
  const empty = join(root, 'empty.mp3');
  await writeFile(empty, '');
  try {
    const error = await readAudioFile(empty, config()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AudioError);
    expect((error as AudioError).message).toContain('empty');
  } finally {
    await rm(empty);
  }
});

test('refuses a file over the byte limit and names the limit', async () => {
  const error = await readAudioFile(inside, config({maxBytes: 4})).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AudioError);
  expect((error as AudioError).message).toContain('MISTRAL_AUDIO_MAX_BYTES');
});

test('accepts a file exactly at the byte limit', async () => {
  const file = await readAudioFile(inside, config({maxBytes: 'fake-audio-bytes'.length}));
  expect(file.content.byteLength).toBe('fake-audio-bytes'.length);
});
