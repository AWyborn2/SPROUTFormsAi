/**
 * Compatibility shim — WorkOS has been replaced by Replit Auth.
 * Re-exports the session sealing utilities so existing test files that
 * import from this module continue to work without a mass-rename.
 * @deprecated Import directly from './replit-auth.js' in new code.
 */
export { sealSession, unsealSession } from './replit-auth.js';
