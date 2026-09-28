/**
 * Creates or updates every collection's indexes from the Mongoose schemas, and drops indexes the schemas
 * no longer declare (plan §3: indexes and schema changes without migrations). Safe to re-run.
 *
 *   npm run db:indexes
 *
 * On AWS it runs from the built image as a one-off task: node dist/sync-indexes.js (plan §13.3).
 */
import { connectDb, disconnectDb } from '../src/db.js';
import { allModels } from '../src/models.js';

async function syncIndexes() {
  const connection = await connectDb();
  console.log(`Database: ${connection.connection.name}`);

  for (const model of allModels) {
    const dropped = await model.syncIndexes();
    const indexes = await model.listIndexes();
    const note = dropped.length > 0 ? `, dropped ${dropped.join(', ')}` : '';
    console.log(`  ${model.collection.collectionName.padEnd(20)} ${indexes.length} indexes${note}`);
  }
}

syncIndexes()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
