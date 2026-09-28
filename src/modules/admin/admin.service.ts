import mongoose from 'mongoose';
import { STAFF_ROLES, UserModel } from '../users/user.model.js';
import type { AdminOverview } from './admin.schemas.js';

export async function getAdminOverview(): Promise<AdminOverview> {
  const [totalUsers, activeHosts, staffMembers, suspendedUsers] = await Promise.all([
    UserModel.countDocuments({ roles: mongoose.trusted({ $in: ['GUEST', 'HOST'] }) }),
    UserModel.countDocuments({ roles: 'HOST', status: 'ACTIVE' }),
    UserModel.countDocuments({ roles: mongoose.trusted({ $in: STAFF_ROLES }), status: 'ACTIVE' }),
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
