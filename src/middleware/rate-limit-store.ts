import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import mongoose, { Schema, model } from 'mongoose';

interface RateLimitCounter {
  _id: string;
  hits: number;
  resetAt: Date;
}

const rateLimitSchema = new Schema<RateLimitCounter>(
  {
    _id: { type: String, required: true },
    hits: { type: Number, required: true },
    // TTL index: MongoDB deletes the counter once its window has ended.
    resetAt: { type: Date, required: true, expires: 0 },
  },
  { collection: 'rateLimits', versionKey: false },
);

export const RateLimitModel = model<RateLimitCounter>('RateLimit', rateLimitSchema);

/**
 * express-rate-limit store that keeps its counters in MongoDB (plan §4.1), so every backend task
 * counts the same visitor together. Each limiter gets its own store with its own prefix.
 */
export class MongoRateLimitStore implements Store {
  readonly localKeys = false;
  private windowMs = 60_000;

  constructor(readonly prefix: string) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = new Date();
    const windowOpen = { $gt: ['$resetAt', now] };
    // One atomic update: add the hit to the current window, or start a new window if it has ended.
    const counter = await RateLimitModel.findOneAndUpdate(
      { _id: this.id(key) },
      [
        {
          $set: {
            hits: { $cond: [windowOpen, { $add: ['$hits', 1] }, 1] },
            resetAt: { $cond: [windowOpen, '$resetAt', new Date(now.getTime() + this.windowMs)] },
          },
        },
      ],
      { upsert: true, new: true, lean: true },
    );
    if (!counter) throw new Error('Rate limit counter was not saved');
    return { totalHits: counter.hits, resetTime: counter.resetAt };
  }

  async decrement(key: string): Promise<void> {
    await RateLimitModel.updateOne(
      {
        _id: this.id(key),
        hits: mongoose.trusted({ $gt: 0 }),
        resetAt: mongoose.trusted({ $gt: new Date() }),
      },
      { $inc: { hits: -1 } },
    );
  }

  async resetKey(key: string): Promise<void> {
    await RateLimitModel.deleteOne({ _id: this.id(key) });
  }

  private id(key: string): string {
    return `${this.prefix}:${key}`;
  }
}
