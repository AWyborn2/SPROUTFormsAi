/**
 * Configuration — the two things the server cannot start without.
 *
 * Both are read from the environment because that is what an MCP client
 * configuration file can set. Failing loudly and immediately matters more here
 * than usual: an agent that reaches a misconfigured server sees tool calls
 * returning 401s and will cheerfully retry them, so the missing variable has to
 * announce itself before the transport ever opens.
 */

export interface McpConfig {
  /** Base URL of the FormAI API, without a trailing slash. */
  apiUrl: string;
  /** An org-scoped API key issued from the app's API keys screen. */
  apiKey: string;
  /**
   * Base URL to compose CALLER-FACING links from, when it differs from
   * `apiUrl`. The stdio server never sets this — its `apiUrl` is already the
   * public base the operator configured. The HTTP mount on the API does: its
   * `apiUrl` is the API's own loopback address, and a document link composed
   * from that reaches the caller as `http://127.0.0.1:8000/...` — a URL only
   * the API host itself could ever fetch.
   */
  publicApiUrl?: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export const API_URL_VAR = 'FORMAI_API_URL';
export const API_KEY_VAR = 'FORMAI_API_KEY';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const apiUrl = env[API_URL_VAR]?.trim();
  const apiKey = env[API_KEY_VAR]?.trim();

  if (!apiUrl) {
    throw new ConfigError(
      `${API_URL_VAR} is not set. Point it at your FormAI API, e.g. https://forms.example.com/api`,
    );
  }
  if (!apiKey) {
    throw new ConfigError(
      `${API_KEY_VAR} is not set. Issue a key from Settings → API keys in the FormAI app.`,
    );
  }

  // Normalised once here so every caller can concatenate a leading-slash path
  // without producing a double slash.
  return { apiUrl: apiUrl.replace(/\/+$/, ''), apiKey };
}
