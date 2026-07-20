import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().default(8787),
  WEB_ORIGIN: z.string().default('http://localhost:5000'),

  DATABASE_URL: z.string().min(1).optional(),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_EXTRACTION_MODEL: z.string().default('claude-sonnet-5'),

  /** Unset means invite emails silently degrade (`emailSent: false`) — never an error. */
  RESEND_API_KEY: z.string().optional(),
  /** The default is Resend's shared onboarding sender, which works without domain verification. */
  RESEND_FROM_EMAIL: z.string().default('FormAI <onboarding@resend.dev>'),

  STRIPE_SECRET_KEY: z.string().optional(),
  SESSION_SECRET: z.string().default('dev-only-insecure-secret'),

  STORAGE_PROVIDER: z.enum(['replit', 'supabase']).default('replit'),
  SUPABASE_STORAGE_BUCKET_PDFS: z.string().default('pdfs'),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);

if (env.NODE_ENV === 'production' && env.SESSION_SECRET === 'dev-only-insecure-secret') {
  throw new Error('SESSION_SECRET must be set to a strong value in production.');
}
