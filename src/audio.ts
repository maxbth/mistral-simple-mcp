import {stat, realpath} from 'node:fs/promises';
import {basename, isAbsolute, sep} from 'node:path';
import {AudioError} from './errors';
import {sentence} from './text';

/**
 * What the transcription tool is allowed to read off local disk.
 *
 * `roots` is an ALLOW-LIST, and an empty one disables local-path input entirely. That default is
 * deliberate. The same build serves stdio — where the client is an agent that already has the
 * user's own filesystem access, so reading a local file crosses no boundary — and Streamable
 * HTTP, where the client is remote and the server process is the only thing standing between it
 * and this machine's disk. Without an allow-list, `filePath` on the HTTP transport is an
 * arbitrary-file-read primitive reachable by anyone who can reach the port. Rather than making
 * the tool behave differently per transport (one rule is auditable; two are a question), local
 * paths are off until an operator names the directories they meant.
 */
export interface AudioConfig {
  roots: Array<string>;
  maxBytes: number;
}

/** The bytes of one audio file, plus the name to present to Mistral. */
export interface AudioFile {
  fileName: string;
  content: Uint8Array;
}

/** Joins a root to the separator that must follow it, without doubling one that is already there. */
function withTrailingSeparator(root: string): string {
  return root.endsWith(sep) ? root : root + sep;
}

/**
 * Reports whether `candidate` is `root` or sits underneath it.
 *
 * The separator is what makes this a containment test rather than a prefix test: a bare
 * `startsWith` would accept `/srv/audio-private/secret.wav` for a root of `/srv/audio`. Both
 * arguments are expected to be fully resolved already — see `readAudioFile`.
 */
function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(withTrailingSeparator(root));
}

/**
 * Resolves a caller-supplied path to a real file inside one of the configured roots.
 *
 * `realpath` is applied to BOTH sides before comparing, which is what closes the two ways a
 * string comparison alone is escapable: `..` segments (a lexical resolve would handle those) and
 * symlinks (it would not — `/srv/audio/escape` pointing at `/etc/shadow` resolves lexically to a
 * path inside the root). A root that is itself a symlink still works, because it goes through the
 * same call.
 *
 * The resolved path is returned so the caller reads THAT rather than the original string. A
 * symlink swapped in between this check and the read would then have to alter a real path's
 * contents, which is not an escape — as opposed to re-resolving the caller's string, where the
 * swap would be the whole attack.
 */
async function resolveWithinRoots(path: string, roots: Array<string>): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    /*
     * The caller's own string is echoed, never the resolved one. A caller already knows what it
     * asked for, so repeating it tells it nothing; a resolved path can name a symlink target and
     * would report this machine's layout to a remote client that guessed at a name.
     */
    throw new AudioError(`No readable file at \`${path}\`. Check the path, or transcribe from a URL with \`fileUrl\` instead.`);
  }

  for (const root of roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(root);
    } catch {
      // A root that does not exist cannot contain anything. Skipping it here rather than failing
      // the call keeps one mistyped entry in MISTRAL_AUDIO_ROOTS from disabling the others.
      continue;
    }
    if (isWithin(resolved, resolvedRoot)) {
      return resolved;
    }
  }

  throw new AudioError(sentence`
    Reading \`${path}\` is not permitted: it is outside every directory in MISTRAL_AUDIO_ROOTS.
    Move the file under one of them, pass \`fileUrl\` instead, or ask the operator to add its
    directory to MISTRAL_AUDIO_ROOTS.
  `);
}

/**
 * Reads a local audio file, refusing anything the operator has not opted into.
 *
 * Every rejection here happens BEFORE the paid request, so a path problem costs nothing. The
 * size is taken from `stat` rather than from the bytes read, so an oversized file is refused
 * without ever being pulled into memory.
 *
 * The file's extension is not checked against a list of audio formats. Mistral decides what it
 * can decode, and a hardcoded list here would either lag behind that or reject something the API
 * would have accepted; an unsupported format comes back as a 422 with a message saying so.
 */
export async function readAudioFile(path: string, config: AudioConfig): Promise<AudioFile> {
  if (config.roots.length === 0) {
    throw new AudioError(sentence`
      Transcribing from a local path is disabled on this server: MISTRAL_AUDIO_ROOTS is not set.
      Pass \`fileUrl\` instead, or ask the operator to set MISTRAL_AUDIO_ROOTS to the directories
      that may be read.
    `);
  }

  if (!isAbsolute(path)) {
    // Resolving a relative path against this process's cwd would make the same argument mean
    // different files depending on how the server was launched, and on stdio the cwd is the
    // client's, not the operator's.
    throw new AudioError(`\`filePath\` must be an absolute path; got \`${path}\`.`);
  }

  const resolved = await resolveWithinRoots(path, config.roots);

  const info = await stat(resolved);
  if (!info.isFile()) {
    throw new AudioError(`\`${path}\` is not a regular file.`);
  }
  if (info.size === 0) {
    throw new AudioError(`\`${path}\` is empty, so there is nothing to transcribe.`);
  }
  if (info.size > config.maxBytes) {
    throw new AudioError(sentence`
      \`${path}\` is ${info.size} bytes, over this server's ${config.maxBytes}-byte limit for one
      audio file. Transcribe a shorter recording, re-encode it at a lower bitrate, or ask the
      operator to raise MISTRAL_AUDIO_MAX_BYTES.
    `);
  }

  const content = new Uint8Array(await Bun.file(resolved).arrayBuffer());

  return {
    // The name is what tells Mistral which container it is looking at, so the real basename is
    // sent rather than a generic one. `basename` cannot return a separator, so this contributes
    // nothing to the multipart body but a file name.
    fileName: basename(resolved) || 'audio',
    content,
  };
}
