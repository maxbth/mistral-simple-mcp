import {z} from 'zod';
import {defineTool, CALLS_A_PAID_API_ANNOTATION} from './types';
import {transcriptionModelSchema} from '../models';
import {readAudioFile} from '../audio';
import {sentence} from '../text';
import type {AudioSource} from '../mistral-client';

/** Mistral documents context biasing as accepting up to 100 terms; more is a 422. */
const MAX_CONTEXT_BIAS_TERMS = 100;

const inputSchema = z
  .object({
    filePath: z.string().min(1).optional().describe(sentence`
        Absolute path to an audio file on the machine running this server. Only paths inside the
        operator-configured \`MISTRAL_AUDIO_ROOTS\` are readable, and the setting is empty by default,
        so use \`fileUrl\` unless you know local paths are enabled here.
      `),
    fileUrl: z.string().url().optional().describe(sentence`
        URL of an audio file. Mistral fetches it directly, so it has to be reachable from Mistral's
        network — a presigned object-storage link works, a link behind your own VPN does not.
      `),
    language: z
      .string()
      .min(2)
      .max(16)
      .optional()
      .describe(
        'ISO 639-1 code of the spoken language, e.g. `en` or `fr`. Detected automatically when omitted; setting it boosts accuracy.',
      ),
    model: transcriptionModelSchema.optional().describe('Model to use. Defaults to the server-configured transcription model.'),
    temperature: z.number().min(0).max(2).optional().describe('Sampling temperature. Transcription usually wants 0.'),
    diarize: z.boolean().default(false).describe('Label each segment with a speaker id. Implies segment timestamps in the response.'),
    contextBias: z.array(z.string().min(1)).max(MAX_CONTEXT_BIAS_TERMS).optional().describe(sentence`
        Up to 100 proper nouns, product names or technical terms that appear in the audio, to steer
        the model toward spelling them correctly.
      `),
    timestampGranularities: z
      .array(z.enum(['segment', 'word']))
      .optional()
      .describe('Ask for timestamped segments in the response: `segment` for per-utterance spans, `word` for per-word.'),
  })
  /*
   * Exactly one source, enforced in the input schema rather than in the handler, so a caller that
   * supplies both or neither is corrected by the protocol before any file is read or any request
   * is paid for. The API rejects both-at-once itself, but only after the upload.
   */
  .refine(
    (input) => Boolean(input.filePath) !== Boolean(input.fileUrl),
    'Provide exactly one of `filePath` or `fileUrl`, not both and not neither.',
  );

export default defineTool({
  name: 'mistral_transcribe',
  config: {
    title: 'Mistral offline audio transcription',
    description: sentence`
      Transcribe a complete audio recording to text with Mistral's Voxtral model. Offline in the
      sense that the whole file is submitted and one finished transcript comes back — this is for
      recordings that already exist (a meeting, a voice memo, a podcast), not for live audio.
      Name the audio with \`fileUrl\`, or with \`filePath\` if the operator has enabled local
      paths. Ask for \`timestampGranularities\` when you need to know when something was said, and
      \`diarize\` when you need to know who said it.
    `,
    inputSchema,
    annotations: CALLS_A_PAID_API_ANNOTATION,
  },
  handler: async (input, {client, audio}) => {
    /*
     * Reading the file first means an unreadable or out-of-bounds path costs nothing: it throws an
     * `AudioError` before the request is built. `audio` defaults to no roots, so a deps object
     * built without it disables local paths rather than silently opening the filesystem.
     */
    let source: AudioSource;
    if (input.filePath) {
      const file = await readAudioFile(
        input.filePath,
        audio ?? {
          roots: [],
          maxBytes: 0,
        },
      );
      source = {
        kind: 'file',
        fileName: file.fileName,
        content: file.content,
      };
    } else {
      // The refine above guarantees one of the two is set, but TypeScript cannot see that through
      // it, and asserting non-null here would turn a future schema change into a runtime crash.
      source = {
        kind: 'url',
        url: input.fileUrl ?? '',
      };
    }

    const result = await client.transcribe({
      audio: source,
      model: input.model,
      language: input.language,
      temperature: input.temperature,
      diarize: input.diarize,
      contextBias: input.contextBias,
      timestampGranularities: input.timestampGranularities,
    });

    return {
      text: result.text,
      model: result.model,
      language: result.language,
      segments: result.segments,
      usage: result.usage,
    };
  },
});
