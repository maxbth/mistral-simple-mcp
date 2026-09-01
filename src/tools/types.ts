import type {z} from 'zod';
import type {MistralClient} from '../mistral-client';
import type {AudioConfig} from '../audio';

export interface ToolDeps {
  client: MistralClient;
  /**
   * Which local directories audio may be read from, and how large one file may be.
   *
   * Optional so a test can construct deps with nothing but a client; omitting it means no roots,
   * which DISABLES local-path input rather than opening the filesystem. `index.ts` always passes
   * the configured value, so the fallback is never what production uses.
   */
  audio?: AudioConfig;
}

/**
 * The contract every tool file satisfies. Handlers return plain data — `server.ts` owns the
 * MCP envelope and error mapping, so no tool file contains protocol boilerplate.
 *
 * Annotations are hardcoded rather than per-tool because every tool carries the same ones: a
 * Mistral call spends money and returns something different each time, which is the exact
 * inverse of the read-only server this layout was borrowed from. Widen this to a per-tool
 * field if a read-only tool is ever added.
 */
export interface ToolModule<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: Schema;
    annotations: {
      readOnlyHint: false;
      destructiveHint: false;
      idempotentHint: false;
    };
  };
  handler: (input: z.infer<Schema>, deps: ToolDeps) => Promise<unknown>;
}

/** Identity function that pins the generic so each tool file gets full inference. */
export function defineTool<Schema extends z.ZodTypeAny>(module: ToolModule<Schema>): ToolModule {
  return module as ToolModule;
}

/** The annotations shared by every tool here. */
export const CALLS_A_PAID_API_ANNOTATION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
} as const;
