import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { env } from './env.js';
import { requireMachineOrTenant } from './middleware/machine.js';
import { accountRouter } from './routes/account.js';
import { apiKeysRouter } from './routes/api-keys.js';
import { orgLogoRouter, publicAssetsRouter } from './routes/assets.js';
import { assessmentCasesRouter, assessmentToolsRouter } from './routes/assessments.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { competenciesRouter, competencyRulesRouter } from './routes/competencies.js';
import { dashboardRouter } from './routes/dashboard.js';
import { formFillLinksRouter, publicFillRouter } from './routes/fill-links.js';
import { formsRouter } from './routes/forms.js';
import { healthRouter } from './routes/health.js';
import { inductionMcpRouter } from '@formai/mcp-inductions/express';
import { inductionsRouter } from './routes/inductions.js';
import { invitesRouter, publicInvitesRouter } from './routes/invites.js';
import { orgRouter } from './routes/org.js';
import { pdfRouter } from './routes/pdf.js';
import { submissionsRouter } from './routes/submissions.js';
import { teamRouter } from './routes/team.js';
import { uploadsRouter } from './routes/uploads.js';
import { voiceRouter } from './routes/voice.js';

/**
 * Builds the Express app. Route groups (auth, forms, import, submissions,
 * team, billing, …) mount here as their feature phases land.
 */
export function createApp(): Express {
  const app = express();
  app.set('trust proxy', true);

  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(cookieParser());

  // /pdf must mount BEFORE the global json parser: a 25 MB PDF is ~34 MB as
  // base64, and middleware runs in registration order — if the global 2 MB
  // parser ran first it would 413 the body before /pdf's own parser ever saw
  // it. The global parser below skips bodies that are already parsed.
  app.use('/pdf', express.json({ limit: '40mb' }), pdfRouter);

  // Same registration-order reason as /pdf above: a 2 MB logo is ~2.7 MB as
  // base64, which the global 2 MB parser would 413 before the route's own
  // size check could return a meaningful error. Scoped to /org/logo so the
  // rest of /org keeps the tighter global limit.
  app.use('/org/logo', express.json({ limit: '8mb' }), orgLogoRouter);

  // Same registration-order reason again: a 10 MB attachment (MAX_ATTACHMENT_BYTES)
  // is ~13.4 MB base64, so both upload doors need their parser mounted before the
  // global 2 MB one — otherwise a phone-camera licence photo 413s with a body the
  // route's own size check never got to write. Scoped to the two upload paths so
  // /fill's submit and the rest of the API keep the tighter global limit.
  const attachmentJson = express.json({ limit: '16mb' });
  app.use('/uploads', attachmentJson, uploadsRouter);
  app.use('/fill/:token/uploads', attachmentJson);

  app.use(express.json({ limit: '2mb' }));

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/account', accountRouter);
  app.use('/org', orgRouter);
  app.use('/forms', formsRouter);
  app.use('/assessment-tools', assessmentToolsRouter);
  app.use('/assessment-cases', assessmentCasesRouter);
  // Authed fill-link management (/forms/:id/fill-links…) — separate router
  // sharing the /forms prefix; unmatched paths fall through to it.
  app.use('/forms', formFillLinksRouter);
  // Public fill surface — token-credentialed, deliberately OUTSIDE
  // requireTenant (auth in this app is per-route middleware; these routes
  // simply never attach it).
  app.use('/fill', publicFillRouter);
  // Invite landing (GET /invites/:token) is public so the accept screen can
  // name the org before asking anyone to sign in; accepting is authenticated
  // and mounts after it, so the more specific POST path wins regardless.
  app.use('/invites', publicInvitesRouter);
  // Org logo serving — public for the same reason /fill is: logged-out
  // respondents must be able to load the branding on a public fill page.
  // The route restricts itself to the logo key namespace (see assets.ts).
  app.use('/assets', publicAssetsRouter);
  app.use('/invites', invitesRouter);
  app.use('/submissions', submissionsRouter);
  app.use('/team', teamRouter);
  // Machine credentials. Session-only by design — a key must not be able to
  // mint or revoke keys (see routes/api-keys.ts).
  app.use('/api-keys', apiKeysRouter);
  // The one router an API key can reach. Everything above stays session-only,
  // so widening machine access is a deliberate mount rather than a side effect.
  app.use('/inductions', inductionsRouter);
  // The same tools over Streamable HTTP, for MCP clients that cannot spawn a
  // local process (a hosted agent, anything not on the operator's machine).
  // `requireMachineOrTenant` runs first so a bad or revoked key is refused
  // before the protocol handshake, rather than surfacing as a tool failure
  // several round trips later. The tools then call this same API back over
  // loopback with the caller's own key — see the router's docstring for why
  // that hop is deliberate.
  app.use(
    '/mcp',
    requireMachineOrTenant,
    inductionMcpRouter({ apiUrl: `http://127.0.0.1:${env.API_PORT}` }),
  );
  app.use('/audit', auditRouter);
  app.use('/dashboard', dashboardRouter);
  app.use('/competencies', competenciesRouter);
  app.use('/competency-rules', competencyRulesRouter);
  // Smart Fill for authed surfaces. The public respondent's door is
  // POST /fill/:token/smart-fill, mounted with the rest of publicFillRouter.
  app.use('/voice', voiceRouter);

  // Fallthrough 404.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}
