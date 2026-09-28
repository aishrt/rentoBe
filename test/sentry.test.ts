import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/env.js';
import { reportError } from '../src/integrations/sentry.js';
import type * as SentryIntegration from '../src/integrations/sentry.js';
import { HttpError } from '../src/lib/http-error.js';
import { errorHandler } from '../src/middleware/error-handler.js';

vi.mock('../src/integrations/sentry.js', () => ({ reportError: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

function appThatThrows(error: unknown) {
  const app = express();
  app.get('/api/v1/boom', () => {
    throw error;
  });
  app.use(errorHandler);
  return app;
}

describe('error reporting', () => {
  it('reports an unexpected error with its route, and answers with the standard 500', async () => {
    const response = await request(appThatThrows(new Error('Database exploded'))).get('/api/v1/boom');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { route: 'GET /api/v1/boom' },
    });
  });

  it("doesn't report expected errors such as a wrong password", async () => {
    const response = await request(
      appThatThrows(new HttpError(401, 'INVALID_CREDENTIALS', 'Wrong password')),
    ).get('/api/v1/boom');

    expect(response.status).toBe(401);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('Sentry setup', () => {
  const dsn = 'https://publickey@o123.ingest.us.sentry.io/456';

  async function initWith(env: object) {
    vi.resetModules();
    const init = vi.fn();
    vi.doMock('@sentry/node', () => ({ init, captureException: vi.fn(), flush: vi.fn() }));
    vi.doMock('../src/env.js', () => ({ env }));
    const { initSentry } = await vi.importActual<typeof SentryIntegration>('../src/integrations/sentry.js');
    initSentry();
    vi.doUnmock('@sentry/node');
    vi.doUnmock('../src/env.js');
    return init;
  }

  it('starts in production when a DSN is set, without personal data', async () => {
    const init = await initWith({
      NODE_ENV: 'production',
      SENTRY_DSN: dsn,
      RELEASE: 'rento-vroom-backend@abc1234',
    });
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn,
        environment: 'production',
        release: 'rento-vroom-backend@abc1234',
        dataCollection: expect.objectContaining({
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          stackFrameVariables: false,
        }),
      }),
    );
  });

  it('never starts in development, even with the DSN in .env', async () => {
    expect(await initWith({ NODE_ENV: 'development', SENTRY_DSN: dsn })).not.toHaveBeenCalled();
    expect(await initWith({ NODE_ENV: 'production' })).not.toHaveBeenCalled();
  });

  it('rejects a SENTRY_DSN that is not a URL', () => {
    const base = {
      MONGODB_URI: 'mongodb://localhost/test',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
      ENCRYPTION_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
    };
    expect(() => parseEnv({ ...base, SENTRY_DSN: 'not-a-dsn' })).toThrow(/SENTRY_DSN/);
    expect(parseEnv({ ...base, SENTRY_DSN: dsn }).SENTRY_DSN).toBe(dsn);
  });
});
