import {McpServer} from '@modelcontextprotocol/server';
import {PublicError} from './errors';
import {TOOLS} from './tools/index';
import type {ToolDeps} from './tools/types';

const NAME = 'mistral-simple-mcp';
const VERSION = '0.1.0';

/**
 * Builds a fully registered MCP server.
 *
 * Both SDK v2 entry points take a factory rather than an instance — `createMcpHandler` calls it
 * per request (which is what makes stateless HTTP work) and `serveStdio` pins one instance per
 * connection. `deps` is created once by the caller and closed over, so per-request construction
 * never means per-request client construction.
 */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    {
      name: NAME,
      version: VERSION,
    },
    {capabilities: {tools: {}}},
  );

  for (const tool of TOOLS) {
    server.registerTool(tool.name, tool.config, async (input: unknown) => {
      try {
        const result = await tool.handler(input, deps);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, undefined, 2),
            },
          ],
        };
      } catch (error) {
        /*
         * A PublicError's message was written to be read by the model — it names what to change
         * and retry. Anything else is an internal detail (a stack, a resolved host, a raw
         * response body) and is replaced, because none of it helps the caller and some of it
         * should not leave this process.
         */
        const message = error instanceof PublicError ? error.message : `Unexpected failure in ${tool.name}.`;
        return {
          content: [
            {
              type: 'text' as const,
              text: message,
            },
          ],
          isError: true,
        };
      }
    });
  }

  return server;
}
