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

    FRONTEND_URL: z.url().default('http://localhost:5173'),
    FRONTEND_ORIGINS: commaSeparatedOrigins.default(['http://localhost:5173']),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    // Optional parent domain for the auth cookies, e.g. ".rentovroom.co.nz" so www. and api. share them.
    COOKIE_DOMAIN: z.string().optional(),

    MAIL_DRIVER: z.enum(['console', 'resend']).default('console'),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().min(3).default('Rento Vroom <hello@mail.example.com>'),
    EMAIL_REPLY_TO: z.email().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.MAIL_DRIVER === 'resend' && !env.RESEND_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY is required when MAIL_DRIVER=resend',
      });
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
