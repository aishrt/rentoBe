import mongoose from 'mongoose';
import { env } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { forget } from '../../lib/memo.js';
import { recordAudit } from '../audit/audit.service.js';
import { notify } from '../notifications/notify.js';
import { HOST_STATUSES, UserModel, type HostStatus } from '../users/user.model.js';
import { toHostVehicleView } from '../vehicles/host-vehicles.service.js';
import { listingChecklist, PHOTO_ANGLE_NAMES } from '../vehicles/listing-checklist.js';
import { vehicleTitle } from '../vehicles/vehicle-view.js';
import { VehicleModel, type VehicleDocument } from '../vehicles/vehicle.model.js';
import { getPlatformSettings } from './platform-settings.service.js';

/*
 * Basic approval queues for staff (plan §9, Days 8–11), so a test listing can go live: Host
 * applications, and listings with their photos and documents. Every decision is in the audit log.
 */

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');
const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `No such ${what}.`);

/** GET /admin/host-applications, oldest first so nobody waits longest. */
export async function listHostApplications(status: HostStatus = 'APPLIED') {
  const settings = await getPlatformSettings();
  const users = await UserModel.find({ 'hostProfile.status': status })
    .sort({ 'hostProfile.appliedAt': 1 })
    .limit(200)
    .lean();
  const counts = await VehicleModel.aggregate<{
    _id: mongoose.Types.ObjectId;
    total: number;
    underReview: number;
  }>([
    { $match: { hostId: { $in: users.map((user) => user._id) } } },
    {
      $group: {
        _id: '$hostId',
        total: { $sum: 1 },
        underReview: { $sum: { $cond: [{ $eq: ['$status', 'UNDER_REVIEW'] }, 1, 0] } },
      },
    },
  ]);
  return users.map((user) => {
    const count = counts.find((row) => row._id.equals(user._id));
    const profile = user.hostProfile!;
    return {
      userId: user._id.toString(),
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      emailVerified: Boolean(user.emailVerifiedAt),
      ...(user.phone && { phone: user.phone }),
      phoneVerified: Boolean(user.phoneVerifiedAt),
      identityStatus: user.identityVerification?.status ?? 'NONE',
      identityRequired: settings.verification.identityForHosts,
      status: profile.status,
      appliedAt: profile.appliedAt.toISOString(),
      ...(profile.bio && { bio: profile.bio }),
      gstRegistered: profile.gstRegistered,
      ...(profile.gstNumber && { gstNumber: profile.gstNumber }),
      ...(profile.reviewNotes && { reviewNotes: profile.reviewNotes }),
      vehicles: { total: count?.total ?? 0, underReview: count?.underReview ?? 0 },
    };
  });
}

export const isHostStatus = (value: unknown): value is HostStatus =>
  typeof value === 'string' && (HOST_STATUSES as readonly string[]).includes(value);

/**
 * Approves or rejects a Host application. Approval needs a confirmed email (plan §6.1) and, while the
 * `identityForHosts` setting is on, a passed identity check (spec §22: Hosts verify their identity as
 * part of the application).
 */
export async function decideHostApplication(
  staffId: string,
  userId: string,
  approved: boolean,
  notes: string | undefined,
  ip?: string,
) {
  if (!mongoose.isValidObjectId(userId)) throw notFound('application');
  const user = await UserModel.findById(userId);
  if (!user?.hostProfile) throw notFound('application');
  if (approved && !user.emailVerifiedAt) {
    throw new HttpError(409, 'EMAIL_NOT_VERIFIED', "The applicant hasn't confirmed their email address yet.");
  }
  if (
    approved &&
    user.identityVerification?.status !== 'APPROVED' &&
    (await getPlatformSettings()).verification.identityForHosts
  ) {
    throw new HttpError(
      409,
      'IDENTITY_NOT_VERIFIED',
      user.identityVerification?.status === 'PENDING'
        ? "The applicant's identity check is waiting for a review in Verifications."
        : "The applicant hasn't passed the identity check yet.",
    );
  }
  const before = user.hostProfile.status;
  user.hostProfile.status = approved ? 'APPROVED' : 'REJECTED';
  user.hostProfile.reviewedBy = new mongoose.Types.ObjectId(staffId);
  user.hostProfile.reviewNotes = notes;
  await user.save();

  await recordAudit({
    actorId: staffId,
    action: approved ? 'host.approved' : 'host.rejected',
    entity: 'user',
    entityId: user.id,
    before: { status: before },
    after: { status: user.hostProfile.status, notes },
    ip,
  });
  await notify({
    userId: user._id,
    type: approved ? 'HOST_APPROVED' : 'HOST_REJECTED',
    title: approved ? "You're approved to host" : 'About your Host application',
    ...(notes && { body: notes }),
    link: approved ? '/host' : '/contact',
    email: {
      template: 'hostApplicationDecision',
      props: {
        firstName: user.firstName,
        approved,
        ...(notes && { notes }),
        url: approved ? `${siteUrl()}/host` : `${siteUrl()}/contact`,
      },
    },
  });
  return { status: user.hostProfile.status };
}

/** GET /admin/vehicles: listings waiting for review, and live ones with new photos or documents. */
export async function listReviewQueue() {
  const settings = await getPlatformSettings();
  const vehicles = await VehicleModel.find({
    $or: [
      { status: 'UNDER_REVIEW' },
      {
        status: mongoose.trusted({ $in: ['ACTIVE', 'INACTIVE'] }),
        $or: [{ 'photos.status': 'PENDING' }, { 'documents.status': 'PENDING' }],
      },
    ],
  })
    .sort({ updatedAt: 1 })
    .limit(200);
  const hosts = await UserModel.find({
    _id: mongoose.trusted({ $in: vehicles.map((vehicle) => vehicle.hostId) }),
  })
    .select('firstName lastName hostProfile.status')
    .lean();

  return vehicles.map((vehicle) => {
    const host = hosts.find((candidate) => candidate._id.equals(vehicle.hostId));
    return {
      id: vehicle.id,
      title: vehicleTitle(vehicle),
      status: vehicle.status,
      host: {
        id: vehicle.hostId.toString(),
        name: host ? `${host.firstName} ${host.lastName}` : 'Unknown',
        status: host?.hostProfile?.status ?? null,
      },
      ...(vehicle.city && { city: vehicle.city }),
      pendingPhotos: vehicle.photos.filter((photo) => photo.status === 'PENDING').length,
      pendingDocuments: vehicle.documents.filter((document) => document.status === 'PENDING').length,
      flags: listingChecklist(vehicle, settings).flags.length,
      updatedAt: vehicle.updatedAt.toISOString(),
    };
  });
}

async function findVehicle(id: string): Promise<VehicleDocument> {
  if (!mongoose.isValidObjectId(id)) throw notFound('car');
  const vehicle = await VehicleModel.findById(id);
  if (!vehicle) throw notFound('car');
  return vehicle;
}

export async function getVehicleForReview(id: string) {
  const vehicle = await findVehicle(id);
  const [host, settings] = await Promise.all([
    UserModel.findById(vehicle.hostId)
      .select(
        'firstName lastName email phone emailVerifiedAt phoneVerifiedAt hostProfile.status hostProfile.payoutsEnabled',
      )
      .lean(),
    getPlatformSettings(),
  ]);
  return {
    vehicle: toHostVehicleView(vehicle, settings),
    host: {
      id: vehicle.hostId.toString(),
      name: host ? `${host.firstName} ${host.lastName}` : 'Unknown',
      email: host?.email ?? '',
      ...(host?.phone && host.phoneVerifiedAt && { phone: host.phone }),
      status: host?.hostProfile?.status ?? null,
      payoutsEnabled: Boolean(host?.hostProfile?.payoutsEnabled),
      emailVerified: Boolean(host?.emailVerifiedAt),
      phoneVerified: Boolean(host?.phoneVerifiedAt),
    },
  };
}

type ListingDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED';

/**
 * Approve, request changes to or reject a listing. Approving also approves its pending photos and
 * verifies its pending documents, and needs an approved Host. Payout setup is enforced once Stripe
 * Connect onboarding is built (plan §8.2, Days 17–18).
 */
export async function decideListing(
  staffId: string,
  id: string,
  decision: ListingDecision,
  notes: string | undefined,
  ip?: string,
) {
  const vehicle = await findVehicle(id);
  const host = await UserModel.findById(vehicle.hostId).select(
    'firstName hostProfile.status hostProfile.payoutsEnabled',
  );
  const before = vehicle.status;
  const live = before === 'ACTIVE' || before === 'INACTIVE';

  if (decision === 'APPROVED') {
    if (host?.hostProfile?.status !== 'APPROVED') {
      throw new HttpError(409, 'HOST_NOT_APPROVED', "Approve the Host's application first.");
    }
    if (before !== 'UNDER_REVIEW' && !live) {
      throw new HttpError(409, 'NOT_UNDER_REVIEW', 'Only a listing under review can be approved.');
    }
    const staff = new mongoose.Types.ObjectId(staffId);
    for (const photo of vehicle.photos) if (photo.status === 'PENDING') photo.status = 'APPROVED';
    for (const document of vehicle.documents) {
      if (document.status === 'PENDING') {
        document.status = 'VERIFIED';
        document.reviewedBy = staff;
      }
    }
    if (before === 'UNDER_REVIEW') {
      vehicle.status = 'ACTIVE';
      // It goes live once the Host's payout setup is done (plan §8.2); until then it waits, approved.
      vehicle.payoutsReady = host.hostProfile.payoutsEnabled;
    }
  } else {
    if (before !== 'UNDER_REVIEW')
      throw new HttpError(409, 'NOT_UNDER_REVIEW', 'Only a listing under review can be sent back.');
    vehicle.status = decision;
  }
  vehicle.reviewNotes = notes;
  await vehicle.save();
  forget('vehicles:featured');

  await recordAudit({
    actorId: staffId,
    action: `vehicle.${decision.toLowerCase().replace('_', '-')}`,
    entity: 'vehicle',
    entityId: vehicle.id,
    before: { status: before },
    after: { status: vehicle.status, notes },
    ip,
  });
  // A live listing's approved changes need no email; a listing's first decision does.
  if (!live && host) {
    const title = vehicleTitle(vehicle);
    // Approved before payout setup: say so, and send the Host to finish it, not to a listing nobody can find.
    const waitingForPayouts = decision === 'APPROVED' && vehicle.payoutsReady === false;
    const link = waitingForPayouts ? '/host/earnings' : `/host/vehicles/${vehicle.id}`;
    await notify({
      userId: vehicle.hostId,
      type: `LISTING_${decision}`,
      title: waitingForPayouts
        ? `Your ${title} is approved`
        : decision === 'APPROVED'
          ? `Your ${title} is live`
          : decision === 'CHANGES_REQUESTED'
            ? `Changes needed on your ${title}`
            : `Your ${title} wasn't approved`,
      ...((notes || waitingForPayouts) && { body: notes ?? 'Set up payouts and it goes live.' }),
      link,
      email: {
        template: 'listingDecision',
        props: {
          firstName: host.firstName,
          vehicleTitle: title,
          decision,
          ...(notes && { notes }),
          ...(waitingForPayouts && { waitingForPayouts }),
          url: `${siteUrl()}${link}`,
        },
      },
    });
  }
  return toHostVehicleView(vehicle, await getPlatformSettings());
}

/** One photo approved or rejected. A rejected one is flagged back to the Host as missing (plan §9). */
export async function decidePhoto(
  staffId: string,
  id: string,
  photoId: string,
  approve: boolean,
  ip?: string,
) {
  const vehicle = await findVehicle(id);
  const photo = vehicle.photos.find((candidate) => candidate._id?.toString() === photoId);
  if (!photo) throw notFound('photo');
  photo.status = approve ? 'APPROVED' : 'REJECTED';
  if (!approve) photo.qualityFlag = 'ADMIN_FLAGGED';
  await vehicle.save();
  forget('vehicles:featured');
  await recordAudit({
    actorId: staffId,
    action: approve ? 'vehicle.photo-approved' : 'vehicle.photo-rejected',
    entity: 'vehicle',
    entityId: vehicle.id,
    after: { photoId, type: photo.type },
    ip,
  });
  if (!approve) {
    await notify({
      userId: vehicle.hostId,
      type: 'LISTING_PHOTO_REJECTED',
      title: `Please retake the ${PHOTO_ANGLE_NAMES[photo.type]} photo`,
      body: `Our team couldn't use the ${PHOTO_ANGLE_NAMES[photo.type]} photo of your ${vehicleTitle(vehicle)}.`,
      link: `/host/vehicles/${vehicle.id}`,
    });
  }
  return toHostVehicleView(vehicle, await getPlatformSettings());
}

export async function decideDocument(
  staffId: string,
  id: string,
  documentId: string,
  verify: boolean,
  ip?: string,
) {
  const vehicle = await findVehicle(id);
  const document = vehicle.documents.find((candidate) => candidate._id?.toString() === documentId);
  if (!document) throw notFound('document');
  document.status = verify ? 'VERIFIED' : 'REJECTED';
  document.reviewedBy = new mongoose.Types.ObjectId(staffId);
  await vehicle.save();
  await recordAudit({
    actorId: staffId,
    action: verify ? 'vehicle.document-verified' : 'vehicle.document-rejected',
    entity: 'vehicle',
    entityId: vehicle.id,
    after: { documentId, type: document.type },
    ip,
  });
  if (!verify) {
    await notify({
      userId: vehicle.hostId,
      type: 'LISTING_DOCUMENT_REJECTED',
      title: 'Please upload a document again',
      body: `Our team couldn't accept a document for your ${vehicleTitle(vehicle)}.`,
      link: `/host/vehicles/${vehicle.id}`,
    });
  }
  return toHostVehicleView(vehicle, await getPlatformSettings());
}
