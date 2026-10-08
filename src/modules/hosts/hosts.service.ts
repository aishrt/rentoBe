import { env } from '../../env.js';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { notify } from '../notifications/notify.js';
import { AGREEMENT_VERSIONS } from '../users/agreements.js';
import { UserModel, type HostProfile } from '../users/user.model.js';
import type { HostApplicationInput, HostProfilePatch, HostProfileView } from './hosts.schemas.js';

/*
 * Becoming a Host (plan §9, Days 8–11; §12.6 Host onboarding): the application comes first, with a
 * verified mobile and the Host Agreement. The Host can add a car straight away; a listing goes live
 * only once the application and the listing are both approved.
 */

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');

export function toHostProfileView(profile: HostProfile, identityRequired: boolean): HostProfileView {
  return {
    status: profile.status,
    appliedAt: profile.appliedAt.toISOString(),
    ...(profile.reviewNotes && { reviewNotes: profile.reviewNotes }),
    ...(profile.bio && { bio: profile.bio }),
    gstRegistered: profile.gstRegistered,
    ...(profile.gstNumber && { gstNumber: profile.gstNumber }),
    payoutsEnabled: profile.payoutsEnabled,
    identityRequired,
    rating: profile.rating ?? { avg: 0, count: 0 },
    tripCount: profile.tripCount ?? 0,
    ...(profile.responseRate !== undefined && { responseRate: profile.responseRate }),
  };
}

/** The view, saying whether approval waits for the identity check (the `identityForHosts` setting). */
async function profileView(profile: HostProfile): Promise<HostProfileView> {
  return toHostProfileView(profile, (await getPlatformSettings()).verification.identityForHosts);
}

async function activeUser(userId: string) {
  const user = await UserModel.findById(userId);
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  return user;
}

/** POST /me/host-application. A rejected applicant can apply again; an approved Host just updates. */
export async function applyToHost(
  userId: string,
  input: HostApplicationInput,
  ip?: string,
): Promise<HostProfileView> {
  const user = await activeUser(userId);
  if (!user.phoneVerifiedAt) {
    throw new HttpError(409, 'PHONE_NOT_VERIFIED', 'Verify your mobile number before applying to host.', {
      phone: 'Verify your mobile number first',
    });
  }
  const current = user.hostProfile?.status;
  if (current === 'SUSPENDED') {
    throw new HttpError(409, 'HOST_SUSPENDED', 'Your hosting is suspended. Please contact support.');
  }

  const now = new Date();
  const alreadyAccepted = user.agreements.some(
    (agreement) => agreement.type === 'HOST' && agreement.version === AGREEMENT_VERSIONS.HOST,
  );
  if (!alreadyAccepted)
    user.agreements.push({ type: 'HOST', version: AGREEMENT_VERSIONS.HOST, acceptedAt: now, ip });
  if (!user.roles.includes('HOST')) user.roles.push('HOST');

  const reapplying = !current || current === 'REJECTED';
  user.hostProfile = {
    status: current === 'APPROVED' ? 'APPROVED' : 'APPLIED',
    appliedAt: reapplying ? now : (user.hostProfile?.appliedAt ?? now),
    reviewNotes: reapplying ? undefined : user.hostProfile?.reviewNotes,
    bio: input.bio,
    gstRegistered: input.gstRegistered,
    gstNumber: input.gstRegistered ? input.gstNumber : undefined,
    payoutsEnabled: user.hostProfile?.payoutsEnabled ?? false,
    tripCount: user.hostProfile?.tripCount ?? 0,
    rating: user.hostProfile?.rating ?? { avg: 0, count: 0 },
    feesOwedCents: user.hostProfile?.feesOwedCents ?? 0,
    reviewedBy: reapplying ? undefined : user.hostProfile?.reviewedBy,
    stripeAccountId: user.hostProfile?.stripeAccountId,
    responseRate: user.hostProfile?.responseRate,
  };
  await user.save();

  await recordAudit({ actorId: user._id, action: 'host.applied', entity: 'user', entityId: user.id, ip });
  if (reapplying) {
    await notify({
      userId: user._id,
      type: 'HOST_APPLICATION_RECEIVED',
      title: "We've got your Host application",
      body: 'Add your car while we review it.',
      link: '/host',
      email: {
        template: 'hostApplicationReceived',
        props: { firstName: user.firstName, listUrl: `${siteUrl()}/host/vehicles/new` },
      },
    });
  }
  return profileView(user.hostProfile!);
}

/** GET /me/host-profile. */
export async function getHostProfile(userId: string): Promise<HostProfileView> {
  const user = await activeUser(userId);
  if (!user.hostProfile) throw new HttpError(404, 'NOT_A_HOST', "You haven't applied to host yet.");
  return profileView(user.hostProfile);
}

/** PATCH /me/host-profile: bio and GST details (plan §11). */
export async function updateHostProfile(userId: string, patch: HostProfilePatch): Promise<HostProfileView> {
  const user = await activeUser(userId);
  if (!user.hostProfile) throw new HttpError(404, 'NOT_A_HOST', "You haven't applied to host yet.");
  const gstRegistered = patch.gstRegistered ?? user.hostProfile.gstRegistered;
  const gstNumber = patch.gstNumber ?? user.hostProfile.gstNumber;
  if (gstRegistered && !gstNumber) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      gstNumber: 'Enter your GST number',
    });
  }
  if (patch.bio !== undefined) user.hostProfile.bio = patch.bio;
  user.hostProfile.gstRegistered = gstRegistered;
  user.hostProfile.gstNumber = gstRegistered ? gstNumber : undefined;
  await user.save();
  return profileView(user.hostProfile);
}
