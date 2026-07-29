import type { StandardSchemaV1 } from '@modelcontextprotocol/server';
import { ApiError } from '../client.js';

/**
 * The date shape every induction tool accepts, defined once so three schemas
 * cannot drift into accepting different things. The package deliberately does
 * not import it from @formai/shared: it must stay installable on its own, and
 * it pins a different Zod major.
 */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The slice of `McpServer` the tool modules actually use.
 *
 * Structural rather than the concrete class so a test can register tools
 * against a two-line fake and call the handler directly, without standing up a
 * transport. It also keeps the SDK's surface from spreading across every tool
 * module.
 */
export interface ToolHost {
  registerTool(
    name: string,
    config: { title?: string; description?: string; inputSchema?: never },
    cb: (args: never) => Promise<ToolResult>,
  ): unknown;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Register a tool with a Zod input schema, keeping the SDK's generics at one call site. */
export function defineTool<Schema extends StandardSchemaV1>(
  host: ToolHost,
  name: string,
  config: { title: string; description: string; inputSchema: Schema },
  handler: (args: StandardSchemaV1.InferOutput<Schema>) => Promise<ToolResult>,
): void {
  (host.registerTool as unknown as (
    n: string,
    c: unknown,
    cb: (a: StandardSchemaV1.InferOutput<Schema>) => Promise<ToolResult>,
  ) => unknown)(name, config, (args) => guard(() => handler(args)));
}

/** JSON payload as a tool result. */
export function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Turns a thrown failure into a tool error that names the API's own code.
 *
 * An agent needs to tell `already_booked` (act differently) from a transport
 * failure (retry) from an authentication problem (stop and tell the human).
 * Collapsing all three into a generic message, or worse into an empty result,
 * is what makes an agent confidently do the wrong thing.
 */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiError) {
      const hint =
        err.status === 401
          ? ' — the FORMAI_API_KEY was rejected; it may be revoked or belong to another workspace'
          : '';
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `${err.code} (HTTP ${err.status})${hint}\n${JSON.stringify(err.detail ?? {}, null, 2)}`,
          },
        ],
      };
    }
    return {
      isError: true,
      content: [{ type: 'text', text: `request_failed: ${(err as Error).message}` }],
    };
  }
}
