import { setServers } from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';
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
