import type { ClientSession } from 'mongoose';
import type Stripe from 'stripe';
import { env } from '../../env.js';
import { stripe } from '../../integrations/stripe.js';
import { logger } from '../../integrations/logger.js';
import { enqueue } from '../../jobs/queue.js';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { nzDate } from '../../lib/nz-time.js';
import { recordAudit } from '../audit/audit.service.js';
import { resolveVerificationReview } from '../bookings/booking.service.js';
import { notify } from '../notifications/notify.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { documentDobHash, flagDuplicateLicence, licenceNumberHash } from './driver-licence.service.js';
import { UserModel, type IdentityVerification } from './user.model.js';

/*
 * Identity checks with Stripe Identity (spec §22; plan §9 Days 19–20): a photo of the person's ID and a
 * matching selfie, on Stripe's own page. ID images stay with Stripe; we keep the result. Guests are asked to
 * use their driver licence as the ID, so one check covers both: the licence number on the document is
 * matched with the one they entered. A check Stripe can't decide, or one that doesn't match, goes to support
 * for a manual review, and a booking made meanwhile becomes a request (plan §8.2).
 */

const PROVIDER = 'stripe_identity';
const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');

/** Stripe's reasons that need a person to look, rather than another try (plan §8.2). */
const REVIEW_CODES = new Set([
  'document_unverified_other',
  'selfie_unverified_other',
  'selfie_face_mismatch',
  'selfie_document_missing_photo',
  'selfie_manipulated',
  'id_number_mismatch',
  'id_number_unverified_other',
  'id_number_insufficient_document_data',
]);

export interface IdentityStatusView {
  status: IdentityVerification['status'];
  sessionStatus?: string;
  lastError?: string;
  documentType?: string;
  verifiedAt?: string;
}

const view = (identity: IdentityVerification | undefined): IdentityStatusView => ({
  status: identity?.status ?? 'NONE',
  ...(identity?.sessionStatus && { sessionStatus: identity.sessionStatus }),
  ...(identity?.lastError && { lastError: identity.lastError }),
  ...(identity?.documentType && { documentType: identity.documentType }),
  ...(identity?.verifiedAt && { verifiedAt: identity.verifiedAt.toISOString() }),
});

/** Only paths inside the website: never a link that leaves it. */
const safeReturn = (path: string | undefined) =>
  path && path.startsWith('/') && !path.startsWith('//') ? path : '/account';

/**
 * POST /me/verification: Stripe's identity page for this person. A check already under way carries on;
 * otherwise a new one starts. Stripe brings them back to `returnTo` on the website.
 */
export async function startIdentityCheck(userId: string, returnTo?: string): Promise<{ url: string }> {
  const user = await UserModel.findById(userId).select('email status identityVerification');
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  const identity = user.identityVerification;
  if (identity?.status === 'APPROVED')
    throw new HttpError(409, 'ALREADY_VERIFIED', 'Your identity is already verified.');
  if (identity?.status === 'PENDING') {
    throw new HttpError(
      409,
      'IN_REVIEW',
      'Our team is checking your identity. We’ll email you when it’s done.',
    );
  }
  if (identity?.status === 'REJECTED') {
    throw new HttpError(
      409,
      'IDENTITY_REJECTED',
      "We couldn't verify your identity. Please contact support.",
    );
  }

  const client = stripe();
  const returnUrl = `${siteUrl()}${safeReturn(returnTo)}`;
  if (identity?.providerRef && identity.sessionStatus === 'requires_input') {
    const existing = await client.identity.verificationSessions.retrieve(identity.providerRef);
    if (existing.status === 'requires_input' && existing.url) return { url: existing.url };
  }
  const session = await client.identity.verificationSessions.create({
    type: 'document',
    options: {
      document: {
        allowed_types: ['driving_license', 'passport', 'id_card'],
        require_matching_selfie: true,
        require_live_capture: true,
      },
    },
    provided_details: { email: user.email },
    client_reference_id: user.id,
    metadata: { userId: user.id },
    return_url: returnUrl,
  });
  const now = new Date();
  // The check this one replaces may hold images too: it's kept so retention redacts it 90 days after it
  // began (plan §14).
  const earlier =
    identity?.providerRef && identity.providerRef !== session.id && !identity.redactedAt
      ? { providerRef: identity.providerRef, startedAt: identity.startedAt ?? now }
      : undefined;
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        'identityVerification.status': 'NONE',
        'identityVerification.provider': PROVIDER,
        'identityVerification.providerRef': session.id,
        'identityVerification.sessionStatus': session.status,
        'identityVerification.startedAt': now,
      },
      // A new check has images of its own until retention redacts them.
      $unset: { 'identityVerification.lastError': 1, 'identityVerification.redactedAt': 1 },
      ...(earlier && { $push: { 'identityVerification.earlierSessions': earlier } }),
    },
  );
  return { url: session.url! };
}

/** Webhook: Stripe has news about a check. The work happens in a job, outside the webhook's transaction. */
export async function queueIdentitySync(
  session: Stripe.Identity.VerificationSession,
  dbSession: ClientSession,
) {
  const userId = session.metadata?.userId ?? session.client_reference_id;
  if (!userId) return;
  await enqueue(
    'identity.sync',
    { userId, sessionId: session.id },
    {
      uniqueKey: `identity-sync:${session.id}:${session.status}:${session.last_error?.code ?? ''}`,
      session: dbSession,
    },
  );
}

/**
 * Reads a check from Stripe and applies it (`identity.sync`, and GET /me/verification while it's under way).
 * Verified: approved, unless the licence number or date of birth on the document doesn't match what the person
 * entered, which goes to support. Bookings that waited for it are confirmed.
 */
export async function syncIdentity(
  userId: string,
  sessionId?: string,
  now = new Date(),
): Promise<IdentityStatusView> {
  const user = await UserModel.findById(userId).select('firstName dob driverLicence identityVerification');
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'No such user.');
  const ref = sessionId ?? user.identityVerification?.providerRef;
  const identity = user.identityVerification;
  // Decided by support or already approved: Stripe's later news doesn't change it.
  if (
    !ref ||
    !identity ||
    identity.providerRef !== ref ||
    ['APPROVED', 'REJECTED', 'PENDING'].includes(identity.status)
  ) {
    return view(identity);
  }
  const session = await stripe().identity.verificationSessions.retrieve(ref);
  let next: Partial<IdentityVerification> = { sessionStatus: session.status };
  let outcome: 'APPROVED' | 'REVIEW' | 'RETRY' | 'WAIT' = 'WAIT';
  // Passed with an ID that didn't confirm the licence: support checks the licence next (plan §8.2).
  let licenceToCheck = false;

  if (session.status === 'verified') {
    let reason: string | undefined;
    let documentType: string | undefined;
    // What the document said, kept (as a keyed hash and a yes or no) for staff checking the licence later.
    let documentNumberHash: string | undefined;
    let documentDobMatched: boolean | undefined;
    let dobHash: string | undefined;
    let licenceMatches = false;
    const reportId =
      typeof session.last_verification_report === 'string'
        ? session.last_verification_report
        : session.last_verification_report?.id;
    if (reportId) {
      try {
        const report = await stripe().identity.verificationReports.retrieve(reportId, {
          expand: ['document.number', 'document.dob'],
        });
        const document = report.document;
        documentType = document?.type ?? undefined;
        if (document?.type === 'driving_license' && document.number) {
          documentNumberHash = licenceNumberHash(document.number);
        }
        if (documentNumberHash && user.driverLicence) {
          licenceMatches = documentNumberHash === user.driverLicence.numberHash;
          if (!licenceMatches) reason = 'The licence number on the ID doesn’t match the one entered.';
        }
        const dob = document?.dob;
        if (dob?.year && dob.month && dob.day) {
          const onDocument = `${dob.year}-${String(dob.month).padStart(2, '0')}-${String(dob.day).padStart(2, '0')}`;
          // Kept as a keyed hash, to compare a date of birth entered later (with the licence).
          dobHash = documentDobHash(onDocument);
          if (user.dob) {
            documentDobMatched = onDocument === nzDate(user.dob);
            if (!documentDobMatched) reason = 'The date of birth on the ID doesn’t match the one entered.';
          }
        }
      } catch (error) {
        // Without the report nothing was compared: the check isn't approved on trust. The identity.sync job
        // retries (the webhook queued it), and the account page shows the check as still running meanwhile.
        logger.warn({ err: error, userId }, 'Could not read the identity report');
        throw error;
      }
    }
    outcome = reason ? 'REVIEW' : 'APPROVED';
    next = {
      ...next,
      ...(documentType && { documentType }),
      ...(documentNumberHash && { documentNumberHash }),
      ...(documentDobMatched !== undefined && { documentDobMatched }),
      ...(dobHash && { documentDobHash: dobHash }),
      ...(reason ? { status: 'PENDING', reviewReason: reason } : { status: 'APPROVED', verifiedAt: now }),
    };
    if (!reason && licenceMatches) {
      await UserModel.updateOne({ _id: user._id }, { $set: { 'driverLicence.status': 'APPROVED' } });
    }
    licenceToCheck = !reason && !licenceMatches && user.driverLicence?.status === 'PENDING';
  } else if (session.status === 'requires_input' && session.last_error?.code) {
    const code = session.last_error.code;
    if (REVIEW_CODES.has(code)) {
      outcome = 'REVIEW';
      next = { ...next, status: 'PENDING', reviewReason: session.last_error.reason ?? code };
    } else {
      outcome = 'RETRY';
      next = {
        ...next,
        lastError: session.last_error.reason ?? 'The check didn’t finish. Please try again.',
      };
    }
  } else if (session.status === 'canceled') {
    outcome = 'RETRY';
  }

  const set = Object.fromEntries(
    Object.entries(next).map(([key, value]) => [`identityVerification.${key}`, value]),
  );
  await UserModel.updateOne({ _id: user._id, 'identityVerification.providerRef': ref }, { $set: set });
  // A licence the ID showed that's on another account is flagged on both (plan §3).
  if (next.documentNumberHash) await flagDuplicateLicence(user._id, next.documentNumberHash, now);

  // Each outcome is emailed as well as shown on the bell (plan §7, "Verification required" and "Verification
  // approved or rejected"); a person who closed the tab mid-check still hears how it went.
  const accountUrl = `${siteUrl()}/account`;
  if (outcome === 'APPROVED') {
    const { confirmed } = await resolveVerificationReview(user.id, 'APPROVE', undefined, now);
    await notify({
      userId: user._id,
      type: 'IDENTITY_APPROVED',
      title: 'Your identity is verified',
      body:
        confirmed.length > 0
          ? `Booking ${confirmed.join(', ')} is confirmed.`
          : licenceToCheck
            ? 'Our team is checking your driver licence next.'
            : 'You’re all set to book.',
      link: '/account',
      email: {
        template: 'tripNotice',
        props: {
          firstName: user.firstName,
          heading: 'Your identity is verified',
          paragraphs: [
            'Your ID and selfie check has passed, so you’re verified on Rento Vroom.',
            confirmed.length > 0
              ? `Your booking ${confirmed.join(', ')} is confirmed.`
              : licenceToCheck
                ? 'Your ID didn’t confirm your driver licence, so our team will check your licence details by hand, usually within a few hours. A booking made meanwhile is held for you as a request, and your card isn’t charged until it’s approved.'
                : 'You’re all set to book a car.',
          ],
          buttonLabel: 'Go to your account',
          url: accountUrl,
        },
      },
      dedupeKey: `IDENTITY_APPROVED:${ref}`,
    });
  } else if (outcome === 'RETRY' && session.status === 'requires_input') {
    // Stripe couldn't verify the ID or selfie and wants another try ("Verification required", spec §19).
    const problem = next.lastError ?? 'The check didn’t finish.';
    await notify({
      userId: user._id,
      type: 'IDENTITY_RETRY',
      title: 'Your identity check needs another try',
      body: problem,
      link: '/account',
      email: {
        template: 'tripNotice',
        props: {
          firstName: user.firstName,
          heading: 'Please try your identity check again',
          paragraphs: [
            `We couldn’t finish checking your ID: ${problem}`,
            'It takes a couple of minutes: a photo of your driver licence (or passport) and a quick selfie. Good light and the whole card in the frame help.',
          ],
          buttonLabel: 'Try again',
          url: accountUrl,
        },
      },
      dedupeKey: `IDENTITY_RETRY:${ref}:${session.last_error?.code ?? 'error'}`,
    });
  } else if (outcome === 'REVIEW') {
    await alertStaff({
      type: 'IDENTITY_REVIEW',
      title: `An identity check needs a review`,
      body: `${user.firstName}'s identity check needs a person to look at it: ${next.reviewReason ?? 'Stripe couldn’t decide'}.`,
      link: '/admin/verifications',
      dedupeKey: `IDENTITY_REVIEW:${ref}`,
    });
    await notify({
      userId: user._id,
      type: 'IDENTITY_IN_REVIEW',
      title: 'We’re checking your details',
      body: 'Our team will finish your identity check, usually within a few hours.',
      link: '/account',
      email: {
        template: 'tripNotice',
        props: {
          firstName: user.firstName,
          heading: 'We’re checking your details',
          paragraphs: [
            'Your identity check needs a quick look from our team, usually within a few hours.',
            'If you’ve booked a car meanwhile, it’s held for you as a request, and your card isn’t charged until the check is approved. We’ll email you when it’s done.',
          ],
          buttonLabel: 'Go to your account',
          url: accountUrl,
        },
      },
      dedupeKey: `IDENTITY_IN_REVIEW:${ref}`,
    });
  }
  const fresh = await UserModel.findById(userId).select('identityVerification').lean();
  return view(fresh?.identityVerification);
}

/** GET /me/verification: where the person's check stands, read again from Stripe while it's under way. */
export async function identityStatus(userId: string): Promise<IdentityStatusView> {
  const user = await UserModel.findById(userId).select('identityVerification').lean();
  const identity = user?.identityVerification;
  if (identity?.status === 'NONE' && identity.providerRef && identity.sessionStatus !== 'canceled') {
    try {
      return await syncIdentity(userId);
    } catch (error) {
      // Stripe couldn't be read just now: the check stays as it was, and the next look tries again.
      logger.warn({ err: error, userId }, 'Could not sync the identity check');
    }
  }
  return view(identity);
}

/**
 * Stripe deletes the ID images and selfie 90 days after a check (plan §14, data retention); the result
 * stays. Called by `daily.dataRetention`.
 */
export async function redactIdentity(userId: string, now = new Date()): Promise<boolean> {
  const user = await UserModel.findById(userId).select('identityVerification').lean();
  const ref = user?.identityVerification?.providerRef;
  if (!ref || user.identityVerification?.redactedAt) return false;
  await stripe().identity.verificationSessions.redact(ref);
  await UserModel.updateOne({ _id: userId }, { $set: { 'identityVerification.redactedAt': now } });
  await recordAudit({ action: 'identity.redacted', entity: 'user', entityId: userId });
  return true;
}

/**
 * The checks a person started before their latest one, each redacted once it began before `cutoff` (plan
 * §14: 90 days). Returns how many were redacted; one Stripe refuses is tried again the next day. Called by
 * `daily.dataRetention`.
 */
export async function redactEarlierSessions(userId: string, cutoff: Date, now = new Date()): Promise<number> {
  const user = await UserModel.findById(userId).select('identityVerification.earlierSessions').lean();
  let redacted = 0;
  for (const earlier of user?.identityVerification?.earlierSessions ?? []) {
    if (earlier.redactedAt || earlier.startedAt > cutoff) continue;
    try {
      await stripe().identity.verificationSessions.redact(earlier.providerRef);
    } catch (error) {
      logger.warn({ err: error, userId }, 'Could not redact an earlier identity check');
      continue;
    }
    await UserModel.updateOne(
      { _id: userId },
      { $set: { 'identityVerification.earlierSessions.$[earlier].redactedAt': now } },
      { arrayFilters: [{ 'earlier.providerRef': earlier.providerRef }] },
    );
    await recordAudit({
      action: 'identity.redacted',
      entity: 'user',
      entityId: userId,
      after: { session: earlier.providerRef },
    });
    redacted += 1;
  }
  return redacted;
}
