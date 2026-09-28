import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose';
import { point } from '../../src/lib/model-fields.js';
import {
  ensurePlatformSettings,
  getPlatformSettings,
} from '../../src/modules/admin/platform-settings.service.js';
import { hashPassword } from '../../src/modules/auth/auth.service.js';
import { AvailabilityBlockModel } from '../../src/modules/availability/availability-block.model.js';
import { BookingModel } from '../../src/modules/bookings/booking.model.js';
import { CmsBlockModel } from '../../src/modules/cms/cms-block.model.js';
import { DestinationModel } from '../../src/modules/cms/destination.model.js';
import { FaqModel } from '../../src/modules/help/faq.model.js';
import { HelpArticleModel } from '../../src/modules/help/help-article.model.js';
import { ReviewModel } from '../../src/modules/reviews/review.model.js';
import { PlaceModel } from '../../src/modules/search/place.model.js';
import { acceptAgreements } from '../../src/modules/users/agreements.js';
import { UserModel, type AgreementType, type UserDocument } from '../../src/modules/users/user.model.js';
import { VehicleModel, type VehicleDocument } from '../../src/modules/vehicles/vehicle.model.js';
import { DEMO_ACCOUNTS } from './demo-accounts.js';
import {
  DEMO_REF_PREFIX,
  GUEST_REVIEWS,
  HOST_REVIEWS,
  TRIPS_PER_VEHICLE,
  demoPrice,
  demoRef,
  demoStars,
} from './demo-trips.js';
import { DEMO_VEHICLES, buildDemoVehicle } from './demo-vehicles.js';
import { DESTINATIONS } from './destinations.js';
import { FAQS } from './faqs.js';
import { HELP_ARTICLES } from './help-articles.js';
import { LEGAL_PAGES } from './legal.js';
import { CITIES, VISITOR_DESTINATIONS } from './places.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type Filter<T> = Parameters<Model<T>['findOne']>[0];

async function findOrCreate<T>(
  model: Model<T>,
  filter: Filter<T>,
  doc: Partial<T>,
): Promise<[HydratedDocument<T>, boolean]> {
  const existing = await model.findOne(filter);
  if (existing) return [existing, false];
  return [await model.create(doc), true];
}

async function createIfMissing<T>(model: Model<T>, filter: Filter<T>, doc: Partial<T>): Promise<number> {
  const [, created] = await findOrCreate(model, filter, doc);
  return created ? 1 : 0;
}

/**
 * Reference data every environment needs: NZ places, the launch destinations, FAQs, help articles,
 * placeholder legal pages and the platform settings. It only adds what's missing, so it never overwrites
 * an admin's edits and can run in production. Returns how many documents it created per collection.
 */
export async function seedReferenceData() {
  const created = { places: 0, destinations: 0, faqs: 0, helpArticles: 0, cmsBlocks: 0, platformSettings: 0 };

  for (const city of CITIES) {
    const [cityPlace, cityCreated] = await findOrCreate(
      PlaceModel,
      { type: 'CITY', name: city.name },
      {
        type: 'CITY',
        name: city.name,
        region: city.region,
        location: point(city.lng, city.lat),
        popularity: city.popularity,
      },
    );
    created.places += cityCreated ? 1 : 0;

    for (const suburb of city.suburbs ?? []) {
      created.places += await createIfMissing(
        PlaceModel,
        { type: 'SUBURB', name: suburb.name, parentId: cityPlace._id },
        {
          type: 'SUBURB',
          name: suburb.name,
          region: city.region,
          location: point(suburb.lng, suburb.lat),
          parentId: cityPlace._id,
          popularity: Math.round(city.popularity / 2),
        },
      );
    }

    if (city.airport) {
      created.places += await createIfMissing(
        PlaceModel,
        { type: 'AIRPORT', code: city.airport.code },
        {
          type: 'AIRPORT',
          name: city.airport.name,
          code: city.airport.code,
          region: city.region,
          location: point(city.airport.lng, city.airport.lat),
          parentId: cityPlace._id,
          popularity: city.popularity,
        },
      );
    }
  }

  for (const destination of VISITOR_DESTINATIONS) {
    created.places += await createIfMissing(
      PlaceModel,
      { type: 'DESTINATION', name: destination.name },
      {
        type: 'DESTINATION',
        name: destination.name,
        region: destination.region,
        location: point(destination.lng, destination.lat),
        popularity: destination.popularity,
      },
    );
  }

  for (const destination of DESTINATIONS) {
    created.destinations += await createIfMissing(DestinationModel, { slug: destination.slug }, destination);
  }
  for (const faq of FAQS) {
    created.faqs += await createIfMissing(FaqModel, { question: faq.question }, faq);
  }
  for (const article of HELP_ARTICLES) {
    created.helpArticles += await createIfMissing(HelpArticleModel, { slug: article.slug }, article);
  }
  for (const page of LEGAL_PAGES) {
    created.cmsBlocks += await createIfMissing(CmsBlockModel, { key: page.key }, page);
  }
  created.platformSettings = (await ensurePlatformSettings()) ? 1 : 0;

  return created;
}

async function upsertDemoAccounts(password: string, now: Date): Promise<Map<string, UserDocument>> {
  const passwordHash = await hashPassword(password);

  for (const account of DEMO_ACCOUNTS) {
    const agreementTypes: AgreementType[] = ['TERMS', 'PRIVACY'];
    if (account.roles.includes('GUEST')) agreementTypes.push('GUEST');
    if (account.roles.includes('HOST')) agreementTypes.push('HOST');
    const isStaff = account.roles.includes('ADMIN') || account.roles.includes('SUPPORT');

    await UserModel.updateOne(
      { email: account.email },
      {
        $set: {
          email: account.email,
          firstName: account.firstName,
          lastName: account.lastName,
          roles: account.roles,
          passwordHash,
          status: 'ACTIVE',
          emailVerifiedAt: now,
          loginFailures: 0,
          agreements: acceptAgreements(agreementTypes, undefined, now),
          ...(!isStaff && {
            identityVerification: { status: 'APPROVED', provider: 'demo', verifiedAt: now },
          }),
          ...(account.hostCity && {
            hostProfile: {
              status: 'APPROVED',
              appliedAt: new Date(now.getTime() - 120 * DAY_MS),
              payoutsEnabled: false,
              bio: account.bio,
              responseRate: 100,
              tripCount: 0,
              rating: { avg: 0, count: 0 },
              feesOwedCents: 0,
              gstRegistered: false,
            },
          }),
        },
        $unset: { lockedUntil: 1 },
      },
      { upsert: true },
    );
  }

  const users = await UserModel.find({
    email: mongoose.trusted({ $in: DEMO_ACCOUNTS.map((account) => account.email) }),
  });
  return new Map(users.map((user) => [user.email, user]));
}

/** Demo trips are rebuilt on every run: the old ones, their reviews and their calendar blocks go first. */
async function removeDemoTrips(): Promise<void> {
  const old = await BookingModel.find(
    { ref: mongoose.trusted({ $regex: `^${DEMO_REF_PREFIX}` }) },
    { _id: 1 },
  );
  const ids = old.map((booking) => booking._id);
  if (ids.length === 0) return;
  await ReviewModel.deleteMany({ bookingId: mongoose.trusted({ $in: ids }) });
  await AvailabilityBlockModel.deleteMany({ bookingId: mongoose.trusted({ $in: ids }) });
  await BookingModel.deleteMany({ _id: mongoose.trusted({ $in: ids }) });
}

async function updateRatings(vehicles: VehicleDocument[], hostIds: Types.ObjectId[]): Promise<void> {
  const vehicleIds = vehicles.map((vehicle) => vehicle._id);
  const round = (value: number) => Math.round(value * 100) / 100;

  const [vehicleRatings, vehicleTrips, hostRatings, hostTrips] = await Promise.all([
    ReviewModel.aggregate<{ _id: Types.ObjectId; avg: number; count: number }>([
      { $match: { direction: 'GUEST_TO_HOST', status: 'PUBLISHED', vehicleId: { $in: vehicleIds } } },
      { $group: { _id: '$vehicleId', avg: { $avg: '$overall' }, count: { $sum: 1 } } },
    ]),
    BookingModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { status: 'COMPLETED', vehicleId: { $in: vehicleIds } } },
      { $group: { _id: '$vehicleId', count: { $sum: 1 } } },
    ]),
    ReviewModel.aggregate<{ _id: Types.ObjectId; avg: number; count: number }>([
      { $match: { direction: 'GUEST_TO_HOST', status: 'PUBLISHED', subjectId: { $in: hostIds } } },
      { $group: { _id: '$subjectId', avg: { $avg: '$overall' }, count: { $sum: 1 } } },
    ]),
    BookingModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { status: 'COMPLETED', hostId: { $in: hostIds } } },
      { $group: { _id: '$hostId', count: { $sum: 1 } } },
    ]),
  ]);

  const find = <T extends { _id: Types.ObjectId }>(rows: T[], id: Types.ObjectId) =>
    rows.find((row) => row._id.equals(id));

  for (const vehicle of vehicles) {
    const rating = find(vehicleRatings, vehicle._id);
    await VehicleModel.updateOne(
      { _id: vehicle._id },
      {
        $set: {
          rating: { avg: rating ? round(rating.avg) : 0, count: rating?.count ?? 0 },
          tripCount: find(vehicleTrips, vehicle._id)?.count ?? 0,
        },
      },
    );
  }
  for (const hostId of hostIds) {
    const rating = find(hostRatings, hostId);
    await UserModel.updateOne(
      { _id: hostId },
      {
        $set: {
          'hostProfile.rating': { avg: rating ? round(rating.avg) : 0, count: rating?.count ?? 0 },
          'hostProfile.tripCount': find(hostTrips, hostId)?.count ?? 0,
        },
      },
    );
  }
}

/**
 * Demo accounts, 20 demo cars and completed demo trips with reviews, for development and staging only
 * (plan §16, item 16: production has no demo cars). Re-running resets them to the seed values.
 */
export async function seedDemoData(password: string, now = new Date()) {
  const settings = await getPlatformSettings();
  const users = await upsertDemoAccounts(password, now);
  const account = (email: string) => {
    const user = users.get(email);
    if (!user) throw new Error(`Demo account ${email} is missing`);
    return user;
  };
  const hostByCity = new Map(
    DEMO_ACCOUNTS.filter((demo) => demo.hostCity).map((demo) => [demo.hostCity, account(demo.email)]),
  );
  const guests = DEMO_ACCOUNTS.filter((demo) => demo.roles.length === 1 && demo.roles[0] === 'GUEST').map(
    (demo) => account(demo.email),
  );

  const vehicles: VehicleDocument[] = [];
  for (const [index, spec] of DEMO_VEHICLES.entries()) {
    const host = hostByCity.get(spec.city);
    if (!host) throw new Error(`No demo host in ${spec.city}`);
    const data = buildDemoVehicle(spec, index, host._id, settings, now);
    const vehicle = await VehicleModel.findOneAndUpdate(
      { slug: data.slug },
      { $set: data },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
    if (!vehicle) throw new Error(`Demo car ${data.slug} wasn't saved`);
    vehicles.push(vehicle);
  }

  await removeDemoTrips();

  const hourStart = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  const bookings = [];
  const reviews = [];
  const blocks = [];
  let tripNumber = 0;

  for (const [index, vehicle] of vehicles.entries()) {
    for (let trip = 0; trip < (TRIPS_PER_VEHICLE[index] ?? 0); trip += 1) {
      tripNumber += 1;
      const guest = guests[tripNumber % guests.length]!;
      const days = 2 + (tripNumber % 4);
      // A week apart for the same car, so its trips never overlap.
      const endAt = new Date(hourStart - (4 + 7 * trip + (index % 5)) * DAY_MS);
      const startAt = new Date(endAt.getTime() - days * DAY_MS);
      const bookedAt = new Date(startAt.getTime() - 10 * DAY_MS);
      const reviewedAt = new Date(endAt.getTime() + DAY_MS);
      const pickup = vehicle.deliveryOptions.find((option) => option.type === 'PICKUP');
      const plan =
        settings.protectionPlans.find((candidate) => candidate.mandatory) ?? settings.protectionPlans[0]!;
      const { price, lineItems } = demoPrice(vehicle.pricing?.dailyCents ?? 0, days, settings);

      const booking = new BookingModel({
        ref: demoRef(tripNumber),
        vehicleId: vehicle._id,
        guestId: guest._id,
        hostId: vehicle.hostId,
        startAt,
        endAt,
        pickupOptionId: pickup?._id,
        returnOptionId: pickup?._id,
        protectionPlan: {
          code: plan.code,
          name: plan.name,
          priceCents: plan.dailyPriceCents * days,
          excessCents: plan.excessCents,
          coverSummary: plan.coverSummary,
          mandatory: plan.mandatory,
        },
        status: 'COMPLETED',
        vehicleSnapshot: {
          title: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
          photoUrl: vehicle.photos[0]?.url,
          regoPlate: vehicle.regoPlate,
        },
        terms: {
          fuelPolicy: vehicle.fuelPolicy,
          kmAllowancePerDay: vehicle.kmAllowancePerDay,
          unlimitedKm: vehicle.unlimitedKm,
          extraKmCents: vehicle.pricing?.extraKmCents ?? 0,
        },
        price,
        lineItems,
        cancellationPolicy: vehicle.rules.cancellationTier,
        statusHistory: [
          { status: 'PAYMENT_PENDING', at: bookedAt, by: guest._id },
          { status: 'CONFIRMED', at: new Date(bookedAt.getTime() + 60_000) },
          { status: 'ACTIVE', at: startAt },
          { status: 'COMPLETED', at: endAt },
        ],
        createdAt: bookedAt,
      });
      bookings.push(booking);
      blocks.push({ vehicleId: vehicle._id, startAt, endAt, reason: 'BOOKED', bookingId: booking._id });

      const guestStars = demoStars(tripNumber);
      reviews.push(
        {
          bookingId: booking._id,
          vehicleId: vehicle._id,
          authorId: guest._id,
          subjectId: vehicle.hostId,
          direction: 'GUEST_TO_HOST',
          overall: guestStars,
          communication: 5,
          pickupReturn: guestStars,
          cleanliness: demoStars(tripNumber + 2),
          body: GUEST_REVIEWS[tripNumber % GUEST_REVIEWS.length],
          status: 'PUBLISHED',
          revealAt: reviewedAt,
          createdAt: reviewedAt,
        },
        {
          bookingId: booking._id,
          authorId: vehicle.hostId,
          subjectId: guest._id,
          direction: 'HOST_TO_GUEST',
          overall: 5,
          communication: 5,
          care: demoStars(tripNumber + 3),
          body: HOST_REVIEWS[tripNumber % HOST_REVIEWS.length],
          status: 'PUBLISHED',
          revealAt: reviewedAt,
          createdAt: reviewedAt,
        },
      );
    }
  }

  await BookingModel.insertMany(bookings);
  await AvailabilityBlockModel.insertMany(blocks);
  await ReviewModel.insertMany(reviews);

  const hostIds = [...hostByCity.values()].map((host) => host._id);
  await updateRatings(vehicles, hostIds);

  return {
    accounts: users.size,
    vehicles: vehicles.length,
    bookings: bookings.length,
    reviews: reviews.length,
  };
}
