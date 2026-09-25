import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { FRONTEND_ORIGIN, testApp } from './helpers.js';

describe('app', () => {
  it('reports healthy when connected to MongoDB', async () => {
    const response = await request(testApp()).get('/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('answers unknown routes with the standard error shape', async () => {
    const response = await request(testApp()).get('/api/v1/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('answers malformed JSON with a 400, not a crash', async () => {
    const response = await request(testApp())
      .post('/api/v1/auth/login')
      .set('Origin', FRONTEND_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('allows credentialed CORS requests from the frontend only', async () => {
    const allowed = await request(testApp()).options('/api/v1/auth/login').set('Origin', FRONTEND_ORIGIN);
    expect(allowed.headers['access-control-allow-origin']).toBe(FRONTEND_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const blocked = await request(testApp())
      .options('/api/v1/auth/login')
      .set('Origin', 'https://evil.example');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });
});
