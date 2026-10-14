/**
 * Passes a person's identity check for the end-to-end tests (frontend/e2e), in place of Stripe Identity's
 * hosted page, which a test can't fill in (a live photo of an ID and a selfie on Stripe's pages). It records
 * what a passed check leaves behind, so a new Host can be approved while the `identityForHosts` setting is
 * on. There's no Stripe session behind it, so the data retention job has nothing to redact. Refuses to run
 * in production or with live Stripe keys.
 *
 *   npx tsx scripts/e2e-identity-check.ts e2e.host.123@rentovroom.test
 */
import { connectDb, disconnectDb } from '../src/db.js';
import { env } from '../src/env.js';
import { UserModel } from '../src/modules/users/user.model.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error('Pass the person’s email: npx tsx scripts/e2e-identity-check.ts <email>');
if (env.NODE_ENV === 'production' || env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
  throw new Error('This stands in for Stripe in local tests only. It never runs in production.');
}

await connectDb();
try {
  const now = new Date();
  const result = await UserModel.updateOne(
    { email },
    {
      $set: {
        identityVerification: {
          status: 'APPROVED',
          provider: 'e2e',
          sessionStatus: 'verified',
          documentType: 'driving_license',
          startedAt: now,
          verifiedAt: now,
        },
      },
    },
  );
  if (result.matchedCount === 0) throw new Error(`No account for ${email}.`);
  console.log(`Identity check passed for ${email}.`);
} finally {
  await disconnectDb();
}
