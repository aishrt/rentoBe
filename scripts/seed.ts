/**
 * Seeds the database (plan §2.4). Safe to re-run.
 *
 * - Reference data in every environment: NZ places, the launch destinations, FAQs, help articles,
 *   placeholder legal pages and the platform settings. Only what's missing is added, so admins' edits
 *   are kept.
 * - Demo accounts, 20 demo cars and completed demo trips with reviews, except in production (plan §16,
 *   item 16). Each run resets them. Needs SEED_DEMO_PASSWORD (12+ characters) in backend/.env.
 *
 *   npm run seed
 */
import { connectDb, disconnectDb } from '../src/db.js';
import { env } from '../src/env.js';
import { DEMO_ACCOUNTS } from './seed-data/demo-accounts.js';
import { seedDemoData, seedReferenceData } from './seed-data/index.js';

const describe = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([collection, count]) => `${collection} ${count}`)
    .join(', ');

async function seed() {
  const withDemo = env.NODE_ENV !== 'production';
  const password = process.env.SEED_DEMO_PASSWORD;
  if (withDemo && (!password || password.length < 12)) {
    throw new Error('Set SEED_DEMO_PASSWORD (12+ characters) in backend/.env before seeding.');
  }

  const connection = await connectDb();
  console.log(`Database: ${connection.connection.name}`);

  console.log(`Reference data added: ${describe(await seedReferenceData())}`);

  if (!withDemo) {
    console.log('Production: demo accounts, cars and trips are not seeded.');
    return;
  }

  console.log(`Demo data written: ${describe(await seedDemoData(password!))}`);
  console.log('Demo accounts (password: the SEED_DEMO_PASSWORD value):');
  for (const account of DEMO_ACCOUNTS) {
    console.log(`  ${account.roles.join('+').padEnd(10)} ${account.email}`);
  }
}

seed()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
