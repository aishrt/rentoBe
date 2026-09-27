import express from 'express';
import { rateLimit, type Options } from 'express-rate-limit';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MongoRateLimitStore, RateLimitModel } from '../src/middleware/rate-limit-store.js';

/** An app with its own limiter and store, standing in for one of the backend's ECS tasks. */
function backendTask(limit: number) {
  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit, store: new MongoRateLimitStore('test') }));
  app.get('/', (_req, res) => {
    res.send('ok');
  });
  return app;
}

function testStore() {
  const store = new MongoRateLimitStore('test');
  store.init({ windowMs: 60_000 } as Options);
  return store;
}

describe('MongoDB rate-limit store', () => {
  it('counts a visitor once across every backend task', async () => {
    const taskA = backendTask(3);
    const taskB = backendTask(3);

    expect((await request(taskA).get('/')).status).toBe(200);
    expect((await request(taskB).get('/')).status).toBe(200);
    expect((await request(taskA).get('/')).status).toBe(200);
    expect((await request(taskB).get('/')).status).toBe(429);
  });

  it('counts simultaneous hits exactly', async () => {
    const store = testStore();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.increment('203.0.113.9')));

    expect(results.map((result) => result.totalHits).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  it('starts a new window once the last one has ended', async () => {
    const store = testStore();
    await store.increment('203.0.113.9');
    await store.increment('203.0.113.9');
    await RateLimitModel.updateOne({ _id: 'test:203.0.113.9' }, { resetAt: new Date(Date.now() - 1_000) });

    const next = await store.increment('203.0.113.9');
    expect(next.totalHits).toBe(1);
    expect(next.resetTime!.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it('can take back a hit or clear a visitor', async () => {
    const store = testStore();
    await store.increment('203.0.113.9');
    await store.increment('203.0.113.9');

    await store.decrement('203.0.113.9');
    expect((await RateLimitModel.findById('test:203.0.113.9'))?.hits).toBe(1);

    await store.resetKey('203.0.113.9');
    expect(await RateLimitModel.countDocuments()).toBe(0);
  });

  it('keeps counters in a collection that MongoDB expires', async () => {
    const indexes = await RateLimitModel.collection.indexes();
    expect(indexes.find((index) => index.key.resetAt)?.expireAfterSeconds).toBe(0);
  });
});
