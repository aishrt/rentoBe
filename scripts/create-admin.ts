/**
 * Creates a staff account (Admin by default). If the email already has an account, it gains the role,
 * gets the new password, is unlocked and reactivated, has its authenticator app removed (so an admin who
 * lost theirs can get back in and set up a new one), and is signed out everywhere; its other details are
 * left alone.
 * Unlike the demo seed this runs in production, where it is how the first admin is created (plan §13.3).
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_FIRST_NAME=Aroha ADMIN_LAST_NAME=Smith npm run create-admin
 *
 * ADMIN_ROLE is ADMIN (default) or SUPPORT. ADMIN_PASSWORD (12+ characters) is optional: without it a
 * random password is generated and printed once. The script prints which database it wrote to.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { connectDb, disconnectDb } from '../src/db.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { SessionModel } from '../src/modules/auth/session.model.js';
import { STAFF_ROLES, UserModel } from '../src/modules/users/user.model.js';

const inputSchema = z.object({
  ADMIN_EMAIL: z
    .string({ error: 'Set ADMIN_EMAIL' })
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: 'ADMIN_EMAIL must be an email address' })),
  ADMIN_FIRST_NAME: z.string({ error: 'Set ADMIN_FIRST_NAME' }).trim().min(1, 'Set ADMIN_FIRST_NAME'),
  ADMIN_LAST_NAME: z.string({ error: 'Set ADMIN_LAST_NAME' }).trim().min(1, 'Set ADMIN_LAST_NAME'),
  ADMIN_ROLE: z.enum(STAFF_ROLES, { error: 'ADMIN_ROLE must be ADMIN or SUPPORT' }).default('ADMIN'),
  ADMIN_PASSWORD: z.string().min(12, 'ADMIN_PASSWORD must be at least 12 characters').optional(),
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
  const generated = input.ADMIN_PASSWORD === undefined;
  const password = input.ADMIN_PASSWORD ?? randomBytes(18).toString('base64url');

  const connection = await connectDb();
  const passwordHash = await hashPassword(password);
  const existing = await UserModel.findOne({ email: input.ADMIN_EMAIL });

  if (existing) {
    await UserModel.updateOne(
      { _id: existing._id },
      {
        $set: { passwordHash, status: 'ACTIVE', loginFailures: 0 },
        $addToSet: { roles: input.ADMIN_ROLE },
        $unset: { lockedUntil: 1, suspendedReason: 1, mfa: 1 },
      },
    );
    await SessionModel.deleteMany({ userId: existing._id });
  } else {
    await UserModel.create({
      email: input.ADMIN_EMAIL,
      passwordHash,
      firstName: input.ADMIN_FIRST_NAME,
      lastName: input.ADMIN_LAST_NAME,
      roles: [input.ADMIN_ROLE],
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
  }

  console.log(`${existing ? 'Updated' : 'Created'} ${input.ADMIN_ROLE} account ${input.ADMIN_EMAIL}`);
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
