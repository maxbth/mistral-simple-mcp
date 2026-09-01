import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {MODELS, DEFAULT_MODEL, TRANSCRIPTION_MODELS, DEFAULT_TRANSCRIPTION_MODEL} from './models';
import {lines} from './text';
import type {Model, TranscriptionModel} from './models';
import type {AudioConfig} from './audio';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface MistralConfig {
  apiKey: string;
  model: Model;
  transcriptionModel: TranscriptionModel;
  timeoutMs: number;
  /** Deadline for one transcription. Its own setting because audio is billed by duration. */
  transcribeTimeoutMs: number;
  baseUrl?: string;
}

export interface McpConfig {
  transport: 'http' | 'stdio';
  host: string;
  port: number;
  path: string;
  authToken?: string;
  allowedOrigins: Array<string>;
}

export interface Config {
  mistral: MistralConfig;
  mcp: McpConfig;
  audio: AudioConfig;
}

const optionalString = z.string().trim().min(1).optional();

/** Splits a comma-separated setting into trimmed, non-empty entries. */
function splitList(value: string): Array<string> {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const schema = z.object({
  MISTRAL_API_KEY: z.string({error: 'MISTRAL_API_KEY is required'}).trim().min(1, 'MISTRAL_API_KEY is required'),
  MISTRAL_DEFAULT_MODEL: z.enum(MODELS).default(DEFAULT_MODEL),
  // Completions are far slower than the metrics reads this server's shape was borrowed from;
  // a large-model request over a long prompt routinely runs past 30s.
  MISTRAL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MISTRAL_TRANSCRIPTION_MODEL: z.enum(TRANSCRIPTION_MODELS).default(DEFAULT_TRANSCRIPTION_MODEL),
  // A transcription is priced and processed by the length of the recording, not by prompt size, so
  // it gets its own deadline rather than sharing the completion one. Five minutes covers a
  // multi-hour file comfortably; Mistral accepts recordings up to three hours per request.
  MISTRAL_TRANSCRIBE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  /*
   * Directories `mistral_transcribe` may read audio from. Empty — the default — disables local
   * paths entirely; see `audio.ts` for why that is the default rather than an open filesystem.
   *
   * Each entry must be ABSOLUTE. A relative root would be resolved against this process's working
   * directory, which on stdio is whatever the client happened to launch from, so the same setting
   * would guard different directories run to run.
   */
  MISTRAL_AUDIO_ROOTS: z
    .string()
    .default('')
    .transform(splitList)
    .refine((roots) => roots.every((root) => isAbsolute(root)), 'MISTRAL_AUDIO_ROOTS entries must be absolute paths'),
  // 100 MiB. This server's own guard against reading a huge file into memory, not Mistral's limit.
  MISTRAL_AUDIO_MAX_BYTES: z.coerce.number().int().positive().default(104_857_600),
  MISTRAL_BASE_URL: z.string().url('MISTRAL_BASE_URL must be a valid URL').optional(),
  MCP_TRANSPORT: z.enum(['http', 'stdio']).default('http'),
  MCP_HOST: z.string().default('127.0.0.1'),
  MCP_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  MCP_HTTP_PATH: z
    .string()
    .trim()
    .min(1)
    .default('/mcp')
    .refine((path) => path.startsWith('/'), 'MCP_HTTP_PATH must start with /'),
  MCP_AUTH_TOKEN: optionalString,
  MCP_ALLOWED_ORIGINS: z.string().default(''),
});

/**
 * Reads and validates configuration. This is the only place in the codebase permitted to
 * touch `process.env`; everything else receives the resolved `Config`.
 *
 * Failures throw `ConfigError` with a message naming exactly what is wrong. Zod issue messages
 * name the failing KEY, never the value, so the API key cannot reach the message — which is
 * why the whole parse result is mapped rather than stringified.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, argv: Array<string> = process.argv.slice(2)): Config {
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value) {
      present[key] = value;
    }
  }

  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`);
    throw new ConfigError(lines`
      Invalid configuration:
        ${problems.join('\n  ')}
    `);
  }

  const data = parsed.data;

  return {
    mistral: {
      apiKey: data.MISTRAL_API_KEY,
      model: data.MISTRAL_DEFAULT_MODEL,
      transcriptionModel: data.MISTRAL_TRANSCRIPTION_MODEL,
      timeoutMs: data.MISTRAL_TIMEOUT_MS,
      transcribeTimeoutMs: data.MISTRAL_TRANSCRIBE_TIMEOUT_MS,
      baseUrl: data.MISTRAL_BASE_URL,
    },
    mcp: {
      transport: argv.includes('--stdio') ? 'stdio' : data.MCP_TRANSPORT,
      host: data.MCP_HOST,
      port: data.MCP_PORT,
      path: data.MCP_HTTP_PATH,
      authToken: data.MCP_AUTH_TOKEN,
      allowedOrigins: splitList(data.MCP_ALLOWED_ORIGINS),
    },
    audio: {
      roots: data.MISTRAL_AUDIO_ROOTS,
      maxBytes: data.MISTRAL_AUDIO_MAX_BYTES,
    },
  };
}
