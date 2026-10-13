import mongoose from 'mongoose';
import type { z } from 'zod';
import { env } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { forget } from '../../lib/memo.js';
import { nzDate } from '../../lib/nz-time.js';
import { recordAudit } from '../audit/audit.service.js';
import { notify } from '../notifications/notify.js';
import { UserModel } from '../users/user.model.js';
import { toHostVehicleView } from '../vehicles/host-vehicles.service.js';
import { listingChecklist, PHOTO_ANGLE_NAMES } from '../vehicles/listing-checklist.js';
import { vehicleTitle } from '../vehicles/vehicle-view.js';
import { VehicleModel, type VehicleDocument } from '../vehicles/vehicle.model.js';
import { upcomingFor } from './admin-bookings.service.js';
import type { hostApplicationsQuerySchema, vehicleListQuerySchema } from './admin-listings.schemas.js';
import { assertNotOwnRecord } from './own-record.js';
import { getPlatformSettings } from './platform-settings.service.js';

/*
 * Basic approval queues for staff (plan §9, Days 8–11), so a test listing can go live: Host
 * applications, and listings with their photos and documents. Every decision is in the audit log. Staff
 * also search every car (plan §12.6), to reach one that isn't waiting for review.
 */

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');
const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `No such ${what}.`);

const APPLICATIONS_PAGE_SIZE = 25;

/**
 * GET /admin/host-applications, a page at a time: those waiting oldest first, so nobody waits longest; those
 * already decided newest first.
 */
export async function listHostApplications(query: z.infer<typeof hostApplicationsQuerySchema>) {
  const filter = { 'hostProfile.status': query.status };
  const order = query.status === 'APPLIED' ? 1 : -1;
  const [settings, users, total] = await Promise.all([
    getPlatformSettings(),
    UserModel.find(filter)
      .sort({ 'hostProfile.appliedAt': order, _id: order })
      .skip((query.page - 1) * APPLICATIONS_PAGE_SIZE)
      .limit(APPLICATIONS_PAGE_SIZE)
      .lean(),
    UserModel.countDocuments(filter),
  ]);
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
  const applications = users.map((user) => {
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
  return { applications, total, page: query.page };
}

/**
 * Approves or rejects a Host application. Approval needs a confirmed email (plan §6.1) and, while the
 * `identityForHosts` setting is on, a passed identity check (spec §22: Hosts verify their identity as
 * part of the application). Only an application waiting for a decision can be rejected, and approved only
 * then or after a rejection: rejecting an approved Host would leave their live cars in search with every
 * booking refused.
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
  await assertNotOwnRecord(staffId, [user._id]);
  const current = user.hostProfile.status;
  if (approved ? current !== 'APPLIED' && current !== 'REJECTED' : current !== 'APPLIED') {
    throw new HttpError(
      409,
      'NOT_APPLIED',
      current === 'APPROVED'
        ? approved
          ? 'This Host is already approved.'
          : 'This Host is already approved. To stop them hosting, suspend their account or their cars instead.'
        : current === 'REJECTED'
          ? 'This application has already been rejected.'
          : 'This Host’s hosting is suspended, so the application can’t be decided here.',
    );
  }
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
      keyChanges: (vehicle.keyChanges ?? []).map((change) => change.field),
      flags: listingChecklist(vehicle, settings).flags.length,
      updatedAt: vehicle.updatedAt.toISOString(),
    };
  });
}

const VEHICLES_PAGE_SIZE = 25;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What one search word can match on a car: its year, make, model or variant, its plate (typed with or
 * without spaces), or its Host's name or email.
 */
async function vehicleWordFilter(word: string) {
  const pattern = new RegExp(escape(word), 'i');
  const plate = word.replace(/\s+/g, '').toUpperCase();
  const hosts = await UserModel.find({
    $or: [{ firstName: pattern }, { lastName: pattern }, { email: pattern }],
  })
    .select('_id')
    .limit(200)
    .lean();
  return {
    $or: [
      { make: pattern },
      { model: pattern },
      { variant: pattern },
      ...(/^\d{4}$/.test(word) ? [{ year: Number(word) }] : []),
      ...(/^[A-Z0-9]{1,6}$/.test(plate) ? [{ regoPlate: new RegExp(escape(plate)) }] : []),
      { hostId: mongoose.trusted({ $in: hosts.map((host) => host._id) }) },
    ],
  };
}

/**
 * GET /admin/vehicles/search (plan §12.6): every car, whatever its status, so staff can find a live car to
 * suspend, a suspended one to put back, or its calendar. Each word must match; most recently changed first.
 */
export async function listVehicles(query: z.infer<typeof vehicleListQuerySchema>) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.hostId) filter.hostId = new mongoose.Types.ObjectId(query.hostId);
  const words = (query.q ?? '').split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length > 0) filter.$and = await Promise.all(words.map(vehicleWordFilter));

  const [vehicles, total, filterHost] = await Promise.all([
    VehicleModel.find(filter)
      .sort({ updatedAt: -1 })
      .skip((query.page - 1) * VEHICLES_PAGE_SIZE)
      .limit(VEHICLES_PAGE_SIZE)
      .select('hostId make model year status regoPlate city payoutsReady hostSuspended tripCount updatedAt')
      .lean(),
    VehicleModel.countDocuments(filter),
    query.hostId ? UserModel.findById(query.hostId).select('firstName lastName').lean() : null,
  ]);
  const hosts = await UserModel.find({
    _id: mongoose.trusted({ $in: vehicles.map((vehicle) => vehicle.hostId) }),
  })
    .select('firstName lastName email')
    .lean();

  return {
    vehicles: vehicles.map((vehicle) => {
      const host = hosts.find((candidate) => candidate._id.equals(vehicle.hostId));
      return {
        id: vehicle._id.toString(),
        title: vehicleTitle(vehicle),
        status: vehicle.status,
        ...(vehicle.regoPlate && { regoPlate: vehicle.regoPlate }),
        ...(vehicle.city && { city: vehicle.city }),
        host: {
          id: vehicle.hostId.toString(),
          name: host ? `${host.firstName} ${host.lastName}` : 'Former member',
          email: host?.email ?? '',
        },
        waitingForPayouts: vehicle.payoutsReady === false,
        hostSuspended: Boolean(vehicle.hostSuspended),
        tripCount: vehicle.tripCount ?? 0,
        updatedAt: vehicle.updatedAt.toISOString(),
      };
    }),
    total,
    page: query.page,
    ...(filterHost && {
      host: { id: filterHost._id.toString(), name: `${filterHost.firstName} ${filterHost.lastName}` },
    }),
  };
}

async function findVehicle(id: string): Promise<VehicleDocument> {
  if (!mongoose.isValidObjectId(id)) throw notFound('car');
  const vehicle = await VehicleModel.findById(id);
  if (!vehicle) throw notFound('car');
  return vehicle;
}

/**
 * GET /admin/vehicles/{id}: the listing as staff review it, with the key details its Host changed since it
 * was live, and while it's suspended, its upcoming bookings still to keep or cancel (plan §8.2), each time
 * the page loads rather than only in the answer to the suspension.
 */
export async function getVehicleForReview(id: string, now = new Date()) {
  const vehicle = await findVehicle(id);
  const [host, settings, upcomingBookings] = await Promise.all([
    UserModel.findById(vehicle.hostId)
      .select(
        'firstName lastName email phone emailVerifiedAt phoneVerifiedAt hostProfile.status hostProfile.payoutsEnabled',
      )
      .lean(),
    getPlatformSettings(),
    vehicle.status === 'SUSPENDED' ? upcomingFor({ vehicleId: vehicle._id }, now) : undefined,
  ]);
  return {
    vehicle: toHostVehicleView(vehicle, settings),
    keyChanges: (vehicle.keyChanges ?? []).map((change) => ({
      field: change.field,
      ...(change.before !== undefined && { before: change.before }),
      ...(change.after !== undefined && { after: change.after }),
      changedAt: change.changedAt.toISOString(),
    })),
    ...(upcomingBookings && { upcomingBookings }),
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
 * Connect onboarding is built (plan §8.2, Days 17–18). A listing back for review over its key details
 * goes back on or off as its Host had it, and the Host hears its changes were approved.
 */
export async function decideListing(
  staffId: string,
  id: string,
  decision: ListingDecision,
  notes: string | undefined,
  ip?: string,
) {
  const vehicle = await findVehicle(id);
  await assertNotOwnRecord(staffId, [vehicle.hostId]);
  const host = await UserModel.findById(vehicle.hostId).select(
    'firstName hostProfile.status hostProfile.payoutsEnabled',
  );
  const before = vehicle.status;
  const live = before === 'ACTIVE' || before === 'INACTIVE';
  // Back for review because its Host changed key details while it was live (plan §3): approval puts it back
  // on or off as its Host had it, since a car its Host switched off stays hidden (plan §8.2).
  const relisting =
    before === 'UNDER_REVIEW' && (vehicle.keyReviewFrom !== undefined || Array.isArray(vehicle.keyChanges));
  /** New photos, documents and key details approved on a live listing, for the Host's email. */
  const changesApproved: string[] = [];

  if (decision === 'APPROVED') {
    if (host?.hostProfile?.status !== 'APPROVED') {
      throw new HttpError(409, 'HOST_NOT_APPROVED', "Approve the Host's application first.");
    }
    if (before !== 'UNDER_REVIEW' && !live) {
      throw new HttpError(409, 'NOT_UNDER_REVIEW', 'Only a listing under review can be approved.');
    }
    const staff = new mongoose.Types.ObjectId(staffId);
    for (const photo of vehicle.photos) {
      if (photo.status === 'PENDING') {
        photo.status = 'APPROVED';
        changesApproved.push(`the ${PHOTO_ANGLE_NAMES[photo.type]} photo`);
      }
    }
    for (const document of vehicle.documents) {
      if (document.status === 'PENDING') {
        document.status = 'VERIFIED';
        document.reviewedBy = staff;
        changesApproved.push(`the ${documentName(document.type)}`);
      }
    }
    if (relisting) {
      for (const change of vehicle.keyChanges ?? []) {
        changesApproved.push(`the new ${KEY_DETAIL_NAMES[change.field]}`);
      }
      if (changesApproved.length === 0) changesApproved.push('the changes to its details');
    }
    if (before === 'UNDER_REVIEW') {
      // Listings sent back for review before it was kept whether they were on were all live.
      vehicle.status = vehicle.keyReviewFrom ?? 'ACTIVE';
      // It goes live once the Host's payout setup is done (plan §8.2); until then it waits, approved.
      vehicle.payoutsReady = host.hostProfile.payoutsEnabled;
    }
  } else {
    if (before !== 'UNDER_REVIEW')
      throw new HttpError(409, 'NOT_UNDER_REVIEW', 'Only a listing under review can be sent back.');
    vehicle.status = decision;
  }
  vehicle.reviewNotes = notes;
  // The key details changed on a live listing are settled by an approval or a rejection; a request for
  // changes keeps them, and whether it was on, for the next look.
  const keyChanges = vehicle.keyChanges?.map((change) => ({
    field: change.field,
    before: change.before,
    after: change.after,
  }));
  if (decision !== 'CHANGES_REQUESTED') {
    vehicle.set('keyChanges', undefined);
    vehicle.set('keyReviewFrom', undefined);
  }
  await vehicle.save();
  forget('vehicles:featured');

  await recordAudit({
    actorId: staffId,
    action: `vehicle.${decision.toLowerCase().replace('_', '-')}`,
    entity: 'vehicle',
    entityId: vehicle.id,
    before: { status: before, ...(keyChanges && keyChanges.length > 0 && { keyChanges }) },
    after: { status: vehicle.status, notes },
    ip,
  });
  // A live listing's approved changes, including key details that sent it back for review (plan §7: "Listing
  // changes approved or rejected"); a listing's first decision, or changes sent back, has its own email below.
  const changesDecided = live || (relisting && decision === 'APPROVED');
  if (changesDecided && host && changesApproved.length > 0) {
    await notifyChangesApproved(vehicle, host.firstName, changesApproved, relisting);
  }
  if (!changesDecided && host) {
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
  await assertNotOwnRecord(staffId, [vehicle.hostId]);
  const photo = vehicle.photos.find((candidate) => candidate._id?.toString() === photoId);
  if (!photo) throw notFound('photo');
  const wasPending = photo.status === 'PENDING';
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
  const host = await UserModel.findById(vehicle.hostId).select('firstName').lean();
  const angle = PHOTO_ANGLE_NAMES[photo.type];
  if (!approve) {
    await notify({
      userId: vehicle.hostId,
      type: 'LISTING_PHOTO_REJECTED',
      title: `Please retake the ${angle} photo`,
      body: `Our team couldn't use the ${angle} photo of your ${vehicleTitle(vehicle)}.`,
      link: `/host/vehicles/${vehicle.id}`,
      // "Listing changes (new photos, documents) approved or rejected" (plan §7).
      email: {
        template: 'tripNotice',
        props: {
          firstName: host?.firstName ?? 'there',
          heading: `Please retake the ${angle} photo of your ${vehicleTitle(vehicle)}`,
          paragraphs: [
            `Our team couldn't use the ${angle} photo of your ${vehicleTitle(vehicle)}: it may be too dark, blurry or not show the whole view.`,
            'Please take a new one and upload it. Guests keep seeing the photos already approved meanwhile.',
          ],
          buttonLabel: 'Upload a new photo',
          url: `${siteUrl()}/host/vehicles/${vehicle.id}/3`,
        },
      },
    });
  } else if (wasPending && isLive(vehicle) && host) {
    await notifyChangesApproved(vehicle, host.firstName, [`the ${angle} photo`]);
  }
  return toHostVehicleView(vehicle, await getPlatformSettings());
}

const isLive = (vehicle: VehicleDocument) => vehicle.status === 'ACTIVE' || vehicle.status === 'INACTIVE';

const DOCUMENT_NAMES: Record<string, string> = {
  REGO: 'registration',
  WOF: 'WOF',
  COF: 'Certificate of Fitness',
  RUC: 'Road User Charges licence',
  INSURANCE: 'insurance document',
  OWNER_CONSENT: 'owner’s consent',
  OTHER: 'document',
};
const documentName = (type: string) => DOCUMENT_NAMES[type] ?? 'document';

/** The key details that send a live listing back for review (plan §3), as the Host's email names them. */
const KEY_DETAIL_NAMES: Record<NonNullable<VehicleDocument['keyChanges']>[number]['field'], string> = {
  regoPlate: 'number plate',
  vin: 'VIN',
  chassisNo: 'chassis number',
  make: 'make',
  model: 'model',
  year: 'year',
};

/**
 * New photos, documents or key details on a live listing were approved (plan §7, "Listing changes approved").
 * One email a day for a car, however many staff approve in one sitting, except key details: their review held
 * the car back, so its end is always told.
 */
async function notifyChangesApproved(
  vehicle: VehicleDocument,
  firstName: string,
  what: string[],
  keyDetails = false,
) {
  const title = vehicleTitle(vehicle);
  const list = what.length === 1 ? what[0]! : `${what.slice(0, -1).join(', ')} and ${what.at(-1)!}`;
  await notify({
    userId: vehicle.hostId,
    type: 'LISTING_CHANGES_APPROVED',
    title: `Your changes to the ${title} are approved`,
    body: `We approved ${list}.`,
    link: `/host/vehicles/${vehicle.id}`,
    email: {
      template: 'tripNotice',
      props: {
        firstName,
        heading: `Your changes to the ${title} are approved`,
        paragraphs: [
          `We’ve approved ${list} for your ${title}.`,
          vehicle.status === 'INACTIVE'
            ? 'It stays switched off, as you left it. Switch it on when you’re ready to take bookings.'
            : 'Guests see the update on your listing now.',
        ],
        buttonLabel: 'View your car',
        url: `${siteUrl()}/host/vehicles/${vehicle.id}`,
      },
    },
    dedupeKey: `LISTING_CHANGES_APPROVED:${vehicle.id}:${keyDetails ? `KEY:${vehicle.updatedAt.getTime()}` : nzDate(new Date())}`,
  });
}

export async function decideDocument(
  staffId: string,
  id: string,
  documentId: string,
  verify: boolean,
  ip?: string,
) {
  const vehicle = await findVehicle(id);
  await assertNotOwnRecord(staffId, [vehicle.hostId]);
  const document = vehicle.documents.find((candidate) => candidate._id?.toString() === documentId);
  if (!document) throw notFound('document');
  const wasPending = document.status === 'PENDING';
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
  const host = await UserModel.findById(vehicle.hostId).select('firstName').lean();
  const name = documentName(document.type);
  if (!verify) {
    await notify({
      userId: vehicle.hostId,
      type: 'LISTING_DOCUMENT_REJECTED',
      title: 'Please upload a document again',
      body: `Our team couldn't accept the ${name} for your ${vehicleTitle(vehicle)}.`,
      link: `/host/vehicles/${vehicle.id}`,
      // "Listing changes (new photos, documents) approved or rejected" (plan §7).
      email: {
        template: 'tripNotice',
        props: {
          firstName: host?.firstName ?? 'there',
          heading: `Please upload the ${name} for your ${vehicleTitle(vehicle)} again`,
          paragraphs: [
            `Our team couldn't accept the ${name} you uploaded for your ${vehicleTitle(vehicle)}: it may be unreadable, out of date, or not match the car.`,
            'Please upload a clear, current copy. If the registered owner isn’t you, add the owner’s written consent too.',
          ],
          buttonLabel: 'Upload it again',
          url: `${siteUrl()}/host/vehicles/${vehicle.id}/2`,
        },
      },
    });
  } else if (wasPending && isLive(vehicle) && host) {
    await notifyChangesApproved(vehicle, host.firstName, [`the ${name}`]);
  }
  return toHostVehicleView(vehicle, await getPlatformSettings());
}
