import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.js';
import type { AnthropicLike } from './pdf/index.js';

let client: Anthropic | null = null;

/**
 * Lazily construct the Anthropic client. Returns null when no key is
 * configured — callers on the flat-PDF path surface a clear "extraction
 * unavailable" error rather than crashing at boot. The key lives only in the
 * API env and never reaches the client.
 */
export function getAnthropic(): AnthropicLike | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client as unknown as AnthropicLike;
}
