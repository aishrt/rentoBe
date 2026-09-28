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

/**
 * Runs `work` in a MongoDB transaction: every write commits together, or none do if it throws.
 * Pass `session` to each query inside. When two transactions write the same document at once,
 * MongoDB aborts one and it runs again from the start (double-booking prevention, plan §3), so
 * `work` must be safe to repeat: database writes only, no emails or Stripe calls.
 */
export function withTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  return mongoose.connection.transaction(work, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  });
}
