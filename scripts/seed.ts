/**
 * Creates or updates the demo accounts used to try sign-in locally and on staging.
 * The full seed (places, destinations, vehicles, FAQs, help articles) arrives with the data models (plan §9, Days 2–3).
 *
 *   npm run seed
 */
import { connectDb, disconnectDb } from '../src/db.js';
import { env } from '../src/env.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { UserModel, type Role } from '../src/modules/users/user.model.js';

interface DemoUser {
  email: string;
  firstName: string;
  lastName: string;
  roles: Role[];
}

const DEMO_USERS: DemoUser[] = [
  { email: 'admin@rentovroom.test', firstName: 'Aroha', lastName: 'Admin', roles: ['ADMIN'] },
  { email: 'support@rentovroom.test', firstName: 'Sam', lastName: 'Support', roles: ['SUPPORT'] },
  { email: 'host@rentovroom.test', firstName: 'Hana', lastName: 'Host', roles: ['GUEST', 'HOST'] },
  { email: 'guest@rentovroom.test', firstName: 'Kiri', lastName: 'Guest', roles: ['GUEST'] },
];

async function seed() {
  if (env.NODE_ENV === 'production') {
    throw new Error('The demo seed never runs in production (plan §16, item 16).');
  }

  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('Set SEED_DEMO_PASSWORD (12+ characters) in backend/.env before seeding.');
  }

  await connectDb();
  const passwordHash = await hashPassword(password);

  for (const user of DEMO_USERS) {
    await UserModel.updateOne(
      { email: user.email },
      {
        $set: { ...user, passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date(), loginFailures: 0 },
        $unset: { lockedUntil: 1 },
      },
      { upsert: true },
    );
  }

  console.log('Demo accounts ready (password: the SEED_DEMO_PASSWORD value):');
  for (const user of DEMO_USERS) console.log(`  ${user.roles.join('+').padEnd(10)} ${user.email}`);
}

seed()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
