import mongoose from 'mongoose';
import { STAFF_ROLES, UserModel } from '../users/user.model.js';

/**
 * KPI figures for the admin overview (spec §18). A metric is `null` until the module that owns its
 * data exists (vehicles, bookings, payments, verification), so the dashboard never shows a made-up zero.
 */
export interface AdminOverview {
  metrics: {
    totalUsers: number;
    activeHosts: number;
    staffMembers: number;
    suspendedUsers: number;
    activeVehicles: number | null;
    upcomingBookings: number | null;
    bookingRevenueCents: number | null;
    pendingVerifications: number | null;
  };
  generatedAt: string;
}

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
