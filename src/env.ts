import { existsSync } from 'node:fs';
import { z } from 'zod';

const splitList = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const commaSeparatedOrigins = z
  .string()
  .transform(splitList)
  .pipe(z.array(z.url({ error: 'Each entry in FRONTEND_ORIGINS must be a full origin URL' })).min(1));

const commaSeparatedIps = z
  .string()
  .transform(splitList)
  .pipe(z.array(z.union([z.ipv4(), z.ipv6()], { error: 'Each entry in DNS_SERVERS must be an IP address' })));

// z.coerce.boolean() would read "false" as true.
const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // Number of proxies in front of Express (CloudFront + load balancer on AWS = 2, section 13.4).
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
    // Optional DNS servers for Node's own lookups. Fixes "querySrv ECONNREFUSED" with mongodb+srv:// URIs
    // on machines where Node can't find the system's DNS server (seen on Windows). Empty = system default.
    DNS_SERVERS: commaSeparatedIps.default([]),

    // Background jobs (plan §4.2): every backend task runs them unless RUN_JOBS=false.
    RUN_JOBS: booleanString.default(true),
    // How many jobs each task runs at once (plan §13.6).
    JOB_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),

    FRONTEND_URL: z.url().default('http://localhost:5173'),
    FRONTEND_ORIGINS: commaSeparatedOrigins.default(['http://localhost:5173']),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    // Encrypts sensitive fields before they're saved, such as staff authenticator secrets (plan §14).
    ENCRYPTION_KEY: z
      .string({ error: 'ENCRYPTION_KEY is required' })
      .refine((value) => Buffer.from(value, 'base64').length === 32, {
        error: 'ENCRYPTION_KEY must be 32 random bytes in base64 (see .env.example)',
      }),
    // Optional parent domain for the auth cookies, e.g. ".rentovroom.co.nz" so www. and api. share them.
    COOKIE_DOMAIN: z.string().optional(),
    // The one administrator (plan §6.2). The ADMIN role only counts on the account with this email, so
    // no other account can act as an admin even if the role is set on it. The create-admin script sets
    // the account up; support staff join by the admin's invitation.
    ADMIN_EMAIL: z
      .string({ error: 'ADMIN_EMAIL is required' })
      .trim()
      .toLowerCase()
      .pipe(z.email({ error: 'ADMIN_EMAIL must be an email address' })),

    // Error monitoring (plan §1.2). Only used when NODE_ENV=production, so development never reports.
    SENTRY_DSN: z.url().optional(),
    SENTRY_ENVIRONMENT: z.string().optional(),
    // The deployed version (git commit), baked into the Docker image, so Sentry can tell releases apart.
    RELEASE: z.string().optional(),

    MAIL_DRIVER: z.enum(['console', 'resend']).default('console'),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().min(3).default('Rento Vroom <hello@mail.example.com>'),
    EMAIL_REPLY_TO: z.email().optional(),

    // Phone verification codes (plan §6.1): "console" logs them locally; "twilio" sends them with Twilio Verify.
    // "dummy" stands in for Twilio on a deployed API until the account is upgraded and has a sender: no
    // texts are sent, the one code that verifies any number is SMS_DUMMY_CODE (keep it in Secrets
    // Manager, never in the repository), and other texts are only logged.
    SMS_DRIVER: z.enum(['console', 'twilio', 'dummy']).default('console'),
    SMS_DUMMY_CODE: z
      .string()
      .regex(/^\d{6}$/, 'SMS_DUMMY_CODE is 6 digits')
      .optional(),
    TWILIO_ACCOUNT_SID: z
      .string()
      .regex(/^AC[0-9a-f]{32}$/, 'TWILIO_ACCOUNT_SID starts with AC')
      .optional(),
    TWILIO_AUTH_TOKEN: z.string().min(32).optional(),
    TWILIO_VERIFY_SERVICE_SID: z
      .string()
      .regex(/^VA[0-9a-f]{32}$/, 'TWILIO_VERIFY_SERVICE_SID starts with VA')
      .optional(),

    // Payments (plan §8). Without these the payment routes answer 503 and the rest of the API works.
    // sk_test_ keys use the Stripe sandbox (no real money); sk_live_ keys take real payments.
    STRIPE_SECRET_KEY: z
      .string()
      .regex(/^(sk|rk)_(test|live)_\w+$/, 'STRIPE_SECRET_KEY starts with sk_test_ or sk_live_')
      .optional(),
    // The signing secret of the webhook endpoint (Stripe Dashboard → Developers → Webhooks).
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .regex(/^whsec_\w+$/, 'STRIPE_WEBHOOK_SECRET starts with whsec_')
      .optional(),
    // The signing secret of the second endpoint, for Connect events about Hosts' payout accounts
    // (account.updated, plan §8.1 item 20). Stripe sends those to an endpoint of their own.
    STRIPE_CONNECT_WEBHOOK_SECRET: z
      .string()
      .regex(/^whsec_\w+$/, 'STRIPE_CONNECT_WEBHOOK_SECRET starts with whsec_')
      .optional(),

    // SMS notifications such as new booking requests (plan §7), sent with Twilio when SMS_DRIVER=twilio.
    // One of the two: a Messaging Service (MG…) or a Twilio number. Twilio has no NZ numbers for SMS: an
    // overseas number works, and NZ phones see the text from a random short code (no replies).
    // Verification codes don't need either; Twilio Verify sends them from its own numbers.
    TWILIO_MESSAGING_SERVICE_SID: z
      .string()
      .regex(/^MG[0-9a-f]{32}$/, 'TWILIO_MESSAGING_SERVICE_SID starts with MG')
      .optional(),
    TWILIO_FROM_NUMBER: z
      .string()
      .regex(/^\+\d{8,15}$/, 'TWILIO_FROM_NUMBER is a number in E.164, e.g. +614…')
      .optional(),

    // Google Maps Platform (plan §1.2), one key for everything and only ever on this server. Location
    // search: "local" suggests our own NZ places only; "google" adds street addresses from Places API (New).
    // With the key set, this API also serves each listing's area map from the Maps Static API.
    PLACES_DRIVER: z.enum(['local', 'google']).default('local'),
    GOOGLE_MAPS_SERVER_KEY: z.string().min(20).optional(),

    // Vehicle photos and documents (plan §1.2). "local" keeps files in UPLOAD_DIR and serves them from
    // this API, for development only; "s3" uploads straight from the browser to S3_BUCKET, and listing
    // photos are served from MEDIA_PUBLIC_URL (CloudFront in front of the bucket's public/ folder).
    // S3 credentials come from the ECS task role in production, or the usual AWS settings elsewhere.
    UPLOAD_DRIVER: z.enum(['local', 's3']).default('local'),
    UPLOAD_DIR: z.string().default('.uploads'),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default('ap-southeast-2'),
    MEDIA_PUBLIC_URL: z.url().optional(),
    // This API's own address as browsers reach it, for links to files the local driver serves.
    API_PUBLIC_URL: z.url().default('http://localhost:4000'),
  })
  .superRefine((env, ctx) => {
    if (env.MAIL_DRIVER === 'resend' && !env.RESEND_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY is required when MAIL_DRIVER=resend',
      });
    }
    if (env.SMS_DRIVER === 'twilio') {
      for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when SMS_DRIVER=twilio` });
        }
      }
    }
    if (env.SMS_DRIVER === 'dummy' && !env.SMS_DUMMY_CODE) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_DUMMY_CODE'],
        message: 'SMS_DUMMY_CODE is required when SMS_DRIVER=dummy',
      });
    }
    if (env.PLACES_DRIVER === 'google' && !env.GOOGLE_MAPS_SERVER_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_MAPS_SERVER_KEY'],
        message: 'GOOGLE_MAPS_SERVER_KEY is required when PLACES_DRIVER=google',
      });
    }
    if (env.UPLOAD_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'MEDIA_PUBLIC_URL'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when UPLOAD_DRIVER=s3` });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  // Empty strings in .env files mean "not set", so defaults and optional checks apply.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return result.data;
}

function loadEnv(): Env {
  // Local development reads backend/.env. On AWS the values come from Secrets Manager (plan §2.5).
  if (process.env.NODE_ENV !== 'test' && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  try {
    return parseEnv(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
