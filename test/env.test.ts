import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env.js';

const baseEnv = {
  MONGODB_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net/rento-vroom-dev',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
};

describe('environment', () => {
  it('uses the system DNS servers unless DNS_SERVERS is set', () => {
    expect(parseEnv(baseEnv).DNS_SERVERS).toEqual([]);
    expect(
      parseEnv({ ...baseEnv, DNS_SERVERS: ' 8.8.8.8, 1.1.1.1 ,2001:4860:4860::8888' }).DNS_SERVERS,
    ).toEqual(['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']);
  });

  it('rejects a DNS_SERVERS entry that is not an IP address', () => {
    expect(() => parseEnv({ ...baseEnv, DNS_SERVERS: '8.8.8.8,dns.google' })).toThrow(/DNS_SERVERS/);
  });

  it('runs background jobs unless RUN_JOBS=false', () => {
    expect(parseEnv(baseEnv)).toMatchObject({ RUN_JOBS: true, JOB_CONCURRENCY: 2 });
    expect(parseEnv({ ...baseEnv, RUN_JOBS: 'false', JOB_CONCURRENCY: '4' })).toMatchObject({
      RUN_JOBS: false,
      JOB_CONCURRENCY: 4,
    });
    expect(() => parseEnv({ ...baseEnv, RUN_JOBS: 'no' })).toThrow(/RUN_JOBS/);
  });

  it('takes Stripe secret keys and webhook secrets, not a publishable key pasted by mistake', () => {
    expect(parseEnv(baseEnv).STRIPE_SECRET_KEY).toBeUndefined();
    expect(
      parseEnv({ ...baseEnv, STRIPE_SECRET_KEY: 'sk_test_51Abc', STRIPE_WEBHOOK_SECRET: 'whsec_Abc123' }),
    ).toMatchObject({ STRIPE_SECRET_KEY: 'sk_test_51Abc', STRIPE_WEBHOOK_SECRET: 'whsec_Abc123' });
    expect(parseEnv({ ...baseEnv, STRIPE_SECRET_KEY: 'rk_live_51Abc' }).STRIPE_SECRET_KEY).toBe(
      'rk_live_51Abc',
    );
    expect(() => parseEnv({ ...baseEnv, STRIPE_SECRET_KEY: 'pk_test_51Abc' })).toThrow(/sk_test_/);
    expect(() => parseEnv({ ...baseEnv, STRIPE_WEBHOOK_SECRET: 'sk_test_51Abc' })).toThrow(/whsec_/);
  });

  it('names every missing required variable', () => {
    expect(() => parseEnv({})).toThrow(/MONGODB_URI[\s\S]*JWT_ACCESS_SECRET/);
  });
});
