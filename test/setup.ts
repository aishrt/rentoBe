import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { connectDb, disconnectDb } from '../src/db.js';

// Every test file gets its own throwaway database, so tests never touch a real cluster.
let server: MongoMemoryServer | undefined;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await connectDb(server.getUri('rento-vroom-test'));
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
});

afterEach(async () => {
  const collections = await mongoose.connection.db?.collections();
  await Promise.all((collections ?? []).map((collection) => collection.deleteMany({})));
});

afterAll(async () => {
  await disconnectDb();
  await server?.stop();
});
