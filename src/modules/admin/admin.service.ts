import mongoose from 'mongoose';
import { env } from '../../env.js';
import { UserModel } from '../users/user.model.js';
import type { AdminOverview } from './admin.schemas.js';

export async function getAdminOverview(): Promise<AdminOverview> {
  const [totalUsers, activeHosts, staffMembers, suspendedUsers] = await Promise.all([
    UserModel.countDocuments({ roles: mongoose.trusted({ $in: ['GUEST', 'HOST'] }) }),
    UserModel.countDocuments({ roles: 'HOST', status: 'ACTIVE' }),
    // The admin is only the ADMIN_EMAIL account (plan §6.2), plus the support team.
    UserModel.countDocuments({
      status: 'ACTIVE',
      $or: [{ roles: 'SUPPORT' }, { roles: 'ADMIN', email: env.ADMIN_EMAIL }],
    }),
    UserModel.countDocuments({ status: 'SUSPENDED' }),
  ]);

  return {
    metrics: {
      totalUsers,
      activeHosts,
      staffMembers,
      suspendedUsers,
      activeVehicles: null,
      upcomingBookings: null,
      bookingRevenueCents: null,
      pendingVerifications: null,
    },
    generatedAt: new Date().toISOString(),
  };
}
