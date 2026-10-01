/**
 * Sets up the one admin (plan §6.2): the account whose email is ADMIN_EMAIL, the same setting the API
 * checks, so the two must match. If the email already has an account, it gains the role, gets the new
 * password, is unlocked and reactivated, has its authenticator apps removed (so an admin who lost
 * theirs can get back in and set up a new one), and is signed out everywhere; its other details are
 * left alone. Any other account with the ADMIN role loses it and is signed out, so there is only ever
 * one admin.
 * Unlike the demo seed this runs in production, where it is how the admin is created (plan §13.3).
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_FIRST_NAME=Aroha ADMIN_LAST_NAME=Smith npm run create-admin
 *
 * Pass ADMIN_EMAIL on the command line when MONGODB_URI points at another environment: otherwise the
 * one in backend/.env is used. ADMIN_PASSWORD (12+ characters) is optional: without it a random
 * password is generated and printed once. The script prints which database it wrote to. Support staff
 * aren't created here: the admin invites them from the staff portal.
 */
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { connectDb, disconnectDb } from '../src/db.js';
import { env } from '../src/env.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { SessionModel } from '../src/modules/auth/session.model.js';
import { UserModel } from '../src/modules/users/user.model.js';

const inputSchema = z.object({
  ADMIN_FIRST_NAME: z.string({ error: 'Set ADMIN_FIRST_NAME' }).trim().min(1, 'Set ADMIN_FIRST_NAME'),
  ADMIN_LAST_NAME: z.string({ error: 'Set ADMIN_LAST_NAME' }).trim().min(1, 'Set ADMIN_LAST_NAME'),
  ADMIN_PASSWORD: z.string().min(12, 'ADMIN_PASSWORD must be at least 12 characters').optional(),
  ADMIN_ROLE: z.undefined({
    error: "ADMIN_ROLE is no longer used: support staff join by the admin's invitation, in the staff portal",
  }),
});

function readInput() {
  // Empty variables mean "not set", as in src/env.ts.
  const source = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''));
  const result = inputSchema.safeParse(source);
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => issue.message).join('\n'));
  }
  return result.data;
}

async function createAdmin() {
  const input = readInput();
  const email = env.ADMIN_EMAIL;
  const generated = input.ADMIN_PASSWORD === undefined;
  const password = input.ADMIN_PASSWORD ?? randomBytes(18).toString('base64url');

  const connection = await connectDb();
  const passwordHash = await hashPassword(password);
  const existing = await UserModel.findOne({ email });

  if (existing) {
    await UserModel.updateOne(
      { _id: existing._id },
      {
        $set: { passwordHash, status: 'ACTIVE', loginFailures: 0 },
        $addToSet: { roles: 'ADMIN' },
        $unset: { lockedUntil: 1, suspendedReason: 1, mfa: 1 },
      },
    );
    await SessionModel.deleteMany({ userId: existing._id });
  } else {
    await UserModel.create({
      email,
      passwordHash,
      firstName: input.ADMIN_FIRST_NAME,
      lastName: input.ADMIN_LAST_NAME,
      roles: ['ADMIN'],
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
  }

  // The API already ignores the role on these accounts; taking it away keeps the database honest.
  const others = await UserModel.find({ roles: 'ADMIN', email: mongoose.trusted({ $ne: email }) }).select(
    'email',
  );
  if (others.length > 0) {
    const ids = others.map((other) => other._id);
    await UserModel.updateMany({ _id: mongoose.trusted({ $in: ids }) }, { $pull: { roles: 'ADMIN' } });
    await SessionModel.deleteMany({ userId: mongoose.trusted({ $in: ids }) });
  }

  console.log(`${existing ? 'Updated' : 'Created'} the admin account ${email}`);
  for (const other of others) console.log(`Removed the ADMIN role from ${other.email}`);
  console.log(`Database: ${connection.connection.name}`);
  if (generated) {
    console.log(`Password (shown once, store it in a password manager): ${password}`);
  }
}

createAdmin()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
