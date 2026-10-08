import { setServers } from 'node:dns';
import mongoose, { type ClientSession } from 'mongoose';
import { env, isProduction } from './env.js';
import { logger } from './integrations/logger.js';

// Block NoSQL operator injection such as { "email": { "$ne": null } } (plan §14).
// Queries that need an operator on purpose wrap it in mongoose.trusted().
mongoose.set('strictQuery', true);
mongoose.set('sanitizeFilter', true);

export async function connectDb(uri: string = env.MONGODB_URI): Promise<typeof mongoose> {
  // The driver looks up mongodb+srv:// hosts with Node's resolver, which DNS_SERVERS can point elsewhere.
  if (env.DNS_SERVERS.length > 0) setServers(env.DNS_SERVERS);

  const connection = await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    // In production the deploy pipeline builds indexes with a one-off `sync-indexes` task before the new
    // version starts (plan §3, §13.3), so starting tasks never build them. Locally Mongoose builds them.
    autoIndex: !isProduction,
  });
  logger.info({ db: connection.connection.name }, 'Connected to MongoDB');
  return connection;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function isDbConnected(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

/** What to do once a transaction commits, by session; see afterCommit(). */
const commitCallbacks = new WeakMap<ClientSession, (() => void)[]>();

/**
 * Runs `callback` once the session's transaction commits, or straight away without one. For things a
 * transaction can't take back, such as a live Socket.IO event: it's sent only if the change is saved,
 * and only once however often MongoDB retries the transaction.
 */
export function afterCommit(session: ClientSession | null | undefined, callback: () => void): void {
  if (!session?.inTransaction()) {
    callback();
    return;
  }
  const callbacks = commitCallbacks.get(session) ?? [];
  callbacks.push(callback);
  commitCallbacks.set(session, callbacks);
}

/**
 * Runs `work` in a MongoDB transaction: every write commits together, or none do if it throws.
 * Pass `session` to each query inside. When two transactions write the same document at once,
 * MongoDB aborts one and it runs again from the start (double-booking prevention, plan §3), so
 * `work` must be safe to repeat: database writes only, no emails or Stripe calls. Anything else
 * waits for the commit through afterCommit().
 */
export async function withTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  let used: ClientSession | undefined;
  const result = await mongoose.connection.transaction(
    (session) => {
      // A retried attempt starts again, without the callbacks of the attempt that was aborted.
      used = session;
      commitCallbacks.delete(session);
      return work(session);
    },
    { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
  );
  const callbacks = used ? (commitCallbacks.get(used) ?? []) : [];
  if (used) commitCallbacks.delete(used);
  for (const callback of callbacks) {
    try {
      callback();
    } catch (error) {
      logger.error({ err: error }, 'An after-commit callback failed');
    }
  }
  return result;
}
