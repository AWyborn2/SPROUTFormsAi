import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { env } from './env.js';
import { accountRouter } from './routes/account.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { competenciesRouter, competencyRulesRouter } from './routes/competencies.js';
import { dashboardRouter } from './routes/dashboard.js';
import { formFillLinksRouter, publicFillRouter } from './routes/fill-links.js';
import { formsRouter } from './routes/forms.js';
import { healthRouter } from './routes/health.js';
import { invitesRouter, publicInvitesRouter } from './routes/invites.js';
import { orgRouter } from './routes/org.js';
import { pdfRouter } from './routes/pdf.js';
import { submissionsRouter } from './routes/submissions.js';
import { teamRouter } from './routes/team.js';

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

  app.use(express.json({ limit: '2mb' }));

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/account', accountRouter);
  app.use('/org', orgRouter);
  app.use('/forms', formsRouter);
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
  app.use('/invites', invitesRouter);
  app.use('/submissions', submissionsRouter);
  app.use('/team', teamRouter);
  app.use('/audit', auditRouter);
  app.use('/dashboard', dashboardRouter);
  app.use('/competencies', competenciesRouter);
  app.use('/competency-rules', competencyRulesRouter);

  // Fallthrough 404.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}
