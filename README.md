# Rento Vroom: Backend

App 2 of 2. The Rento Vroom API: Node.js 22 + Express + TypeScript, with MongoDB (Atlas) through Mongoose.

- Deployed on its own as one Docker container service on AWS ECS Fargate (`api.<domain>`).
- Runs the REST API (`/api/v1`), Socket.IO, the background job runner and the page tags for vehicle and destination pages (`/pages`) in one process. Nothing else is deployed.
- Owns every business rule: pricing, availability, payments, permissions.
- Shares no code with `frontend/`. The API contract is published as `openapi.json`.

See [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md), sections 2 (structure and commands), 3–8 (data, jobs, pricing, auth, payments) and 13 (deployment).

## Run it locally

```bash
cd backend
npm install
cp .env.example .env    # then fill in MONGODB_URI, JWT_ACCESS_SECRET and SEED_DEMO_PASSWORD
npm run seed            # NZ places, destinations, FAQs, help articles, settings, and the demo data below
npm run dev             # API on http://localhost:4000
```

`MONGODB_URI` points at your MongoDB cluster (include a database name, e.g. `.../rento-vroom-dev`). Docker is not needed.

**`querySrv ECONNREFUSED` when connecting?** Node can't reach a DNS server to look up the `mongodb+srv://` address (common on Windows, where Node sometimes falls back to `127.0.0.1`). Add `DNS_SERVERS=8.8.8.8,1.1.1.1` to `.env`. If it still fails, check that your IP address is allowed under Network Access in MongoDB Atlas.

`npm run seed` is safe to re-run. It writes two kinds of data:

- **Reference data**, in every environment: 83 NZ places (cities, suburbs, airports and visitor destinations, for autocomplete and airport search), the 5 launch destination pages, 12 FAQs, 9 help articles, placeholder legal pages and the platform settings. It only adds what's missing, so it never overwrites an admin's edits.
- **Demo data**, everywhere except production: the accounts below, 20 live demo cars (four in each launch city, with placeholder photos) and 20 completed trips with reviews in both directions, so ratings and trip history have something to show. Each run resets them.

Demo accounts (password: your `SEED_DEMO_PASSWORD`):

| Account                             | Roles        | Notes                                     |
| ----------------------------------- | ------------ | ----------------------------------------- |
| `admin@rentovroom.test`             | Admin        |                                           |
| `support@rentovroom.test`           | Support      |                                           |
| `host@rentovroom.test`              | Guest + Host | 4 cars in Auckland                        |
| `host.wellington@rentovroom.test`   | Guest + Host | 4 cars in Wellington                      |
| `host.christchurch@rentovroom.test` | Guest + Host | 4 cars in Christchurch                    |
| `host.queenstown@rentovroom.test`   | Guest + Host | 4 cars in Queenstown                      |
| `host.rotorua@rentovroom.test`      | Guest + Host | 4 cars in Rotorua                         |
| `host.applicant@rentovroom.test`    | Guest + Host | Applied to host; one listing under review |
| `guest@rentovroom.test`             | Guest        | Past trips and reviews                    |
| `visitor@rentovroom.test`           | Guest        | Overseas licence                          |
| `guest2@rentovroom.test`            | Guest        | Past trips and reviews                    |

Demo Guests have verified mobiles and approved licence details, so they can book straight away; demo Hosts have verified mobiles for booking texts. The applicant and their listing fill the staff portal's approval queues.

## Commands

| Command                                           | What it does                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                     | API with reload on change (`tsx watch`)                                                                                                                                      |
| `npm run build` / `npm start`                     | Bundle to `dist/` with tsup / run the bundle with plain `node`                                                                                                               |
| `npm run lint` · `npm run typecheck` · `npm test` | Checks. Tests use an in-memory MongoDB replica set, so they never touch your cluster (the first run downloads a MongoDB binary).                                             |
| `npm run seed`                                    | Reference data, plus demo accounts, cars and trips outside production (see above)                                                                                            |
| `npm run db:indexes`                              | Creates or updates every collection's indexes from the Mongoose schemas, and drops indexes the schemas no longer declare                                                     |
| `npm run openapi`                                 | Writes the API contract to `openapi.json` from the routes' Zod schemas. Commit it: `npm test` fails while it's out of date, and the website generates its API types from it. |
| `npm run create-admin`                            | Creates or resets a staff account, also in production (the first admin). Inputs in `scripts/create-admin.ts`                                                                 |
| `npm run email:dev`                               | Previews every email template in the browser on http://localhost:3030, with sample details. Nothing is sent.                                                                 |
| `npm run email:test -- you@example.com`           | Sends the welcome email through the configured mailer                                                                                                                        |
| `npm run format`                                  | Prettier                                                                                                                                                                     |

## Data model

Every collection in plan §3 has a Mongoose model in its module (`src/modules/<module>/<name>.model.ts`), and `src/models.ts` lists them all.

- Shared field types are in `src/lib/model-fields.ts`: money as whole NZD cents (`cents()`), GeoJSON points (`[longitude, latitude]`), the structured NZ address and star ratings.
- Indexes are declared in the schemas. Locally, Mongoose builds a model's indexes when it's first used, and `npm run db:indexes` syncs every collection at once. Production never builds them at startup (`autoIndex` is off): each deploy runs `dist/sync-indexes.js` as a one-off ECS task before the new version starts, and stops if it fails.
- Schema changes are additive: a new field is optional or has a default, so existing documents keep working without a migration.
- Platform settings (fees, cancellation tiers, protection plans, eligibility, review windows and more) come from `getPlatformSettings()` in `src/modules/admin/platform-settings.service.ts`: what admins saved, over the launch defaults in `default-settings.ts`. The defaults are placeholders until the client decides (plan §16).
- Filters with operators need `mongoose.trusted()`, because `sanitizeFilter` is on (see `src/db.ts`).

## Email

Emails are React Email templates in `src/emails`, sent through the `Mailer` interface in `src/integrations/mailer` (plan §7):

- `MAIL_DRIVER=console` (default): nothing is sent. Each email's subject and links are logged and the HTML is saved to `backend/.mail/`.
- `MAIL_DRIVER=resend`: sends through [Resend](https://resend.com). Needs `RESEND_API_KEY` and an `EMAIL_FROM` address on a domain verified in Resend.

Add a template in `src/emails/templates/`, register it in `emailTemplates` (`src/emails/index.ts`) and give it sample details in `src/emails/preview-props.ts` for `npm run email:dev`. Features send it through the job queue, `enqueue('email.send', { to, template, props })`, which is type-checked against the template's props and retried if sending fails.

## Background jobs

A MongoDB `jobs` collection and a runner inside the API process (plan §4.2). No separate worker, no Redis.

- `enqueue(type, payload, { runAt, uniqueKey, refId })` in `src/jobs/queue.ts` adds a job. A `uniqueKey` means the job is only ever created once. `cancelJobs(refId)` cancels a record's queued jobs.
- Every API process polls every 5 s and claims due jobs with an atomic update, so two processes never run the same job. `RUN_JOBS=false` turns this off, and `JOB_CONCURRENCY` sets how many jobs run at once (default 2).
- A failed job is retried after 1 min, 5 min, 25 min and 2 h, then marked `FAILED` and logged as `Job failed permanently`. A job left `RUNNING` for 10 minutes by a crashed process goes back in the queue. On shutdown, unfinished jobs go back in the queue.
- Add a job type with a handler in `src/jobs/handlers/` and register it in `jobHandlers`. Handlers must be safe to run twice.

## Realtime (Socket.IO)

Socket.IO runs on the same server as the API, on `/socket.io` (plan §4.4).

- Only signed-in users connect: browsers send the access cookie from a trusted origin, and mobile apps pass `auth: { token }`. Refused connections get the error `UNAUTHENTICATED`.
- Each connection joins the room `user:<id>`. `emitToUser(userId, event, payload)` in `src/realtime/realtime.ts` sends to every tab and device of that user.
- The MongoDB adapter (`@socket.io/mongo-adapter`) passes events between API processes through the `socketEvents` collection and a change stream. That needs a replica set: Atlas always is one, and the tests use an in-memory one.

## Website pages (`/pages`)

The website is a single-page app, so vehicle and destination pages get their search and link-preview tags from the backend (plan §1.4). The website's CloudFront sends `/cars/*`, `/rental/*` and `/sitemap.xml` through `https://api.<domain>/pages` (see DEPLOYING_UPDATES.md), and caches the answers for 60 s.

- `GET /pages/cars/:slug` and `GET /pages/rental/:city`: the website's current `index.html` (fetched from `FRONTEND_URL` and kept for 60 s) with the car's or destination's title, description, canonical URL, link-preview tags and JSON-LD. An unknown or inactive car, or an unknown destination, is a real 404. A destination with no cars yet is a normal page. The exact address and the number plate are never included.
- `GET /pages/sitemap.xml`: the website's indexable pages, destinations and live cars.
- What's indexable comes from the website's `seo-manifest.json`, written by its build. Until the website has built vehicle or destination pages, their tags say `noindex` and the sitemap leaves them out, so search engines never list an unfinished page.
- If the website can't be reached, the answer is 502 and CloudFront serves the plain `index.html` instead.

## Search and listings

- `GET /search` runs one `$geoNear` aggregation with every filter in spec §5 (plan §3). With dates, cars that have a block in the range, need more notice, can't do that trip length, or whose rego or WOF expires first are left out, and each card gets an estimated total from the pricing engine. An airport search also finds cars up to 250 km away that deliver to that airport, with the delivery fee in the estimate. Unknown filter values are ignored.
- `GET /places/suggest` suggests our own places (a prefix search on `searchName`, so "taupo" finds Taupō), then street addresses from Google Places once `PLACES_DRIVER=google` and `GOOGLE_MAPS_SERVER_KEY` are set.
- `GET /vehicles/{slug}` is the public listing: approved photos only, the rego and WOF status by month, the suburb, and a 1 km circle around a point up to 400 m from the car. Never the plate or the address.
- `src/modules/pricing/pricing.ts` is the only place prices are calculated (plan §5): trip days on NZ wall-clock time, weekly and monthly discounts, the service fee, protection, delivery, and GST per line (3/23 of each GST-inclusive amount). `POST /vehicles/{id}/quote` returns the breakdown and every problem in the way, and holds nothing.

## Hosting

- `POST /me/host-application` needs a verified mobile and the Host Agreement, and adds the HOST role. A Host can add a car at once; a listing goes live only when staff have approved both the application and the listing.
- `/host/vehicles` saves the 6-step onboarding as a draft at every step (`PATCH` with any subset of fields). `POST …/submit` runs the missing-items check (required documents and photo angles come from settings) and puts the listing in the review queue.
- Editing a live listing (plan §3): price, rules and delivery change at once; new photos and documents wait for staff; a new plate, VIN, chassis number, make, model or year sends it back to review.
- The calendar: Host blocks, recurring rules expanded 12 months ahead (topped up monthly by `availability.expandRecurring`), and a staff override. Every calendar write goes through `src/modules/availability/availability.service.ts`, inside a transaction that first bumps the car's `bookingSeq`, so two writes for one car can never both pass the overlap check. A test sends 20 simultaneous bookings for one car and checks exactly one gets through.
- Staff queues: `/admin/host-applications` (approve or reject) and `/admin/vehicles` (approve, request changes or reject a listing; approve or reject each photo and document).

## Uploads

Browsers upload straight to storage with a short-lived signed target from `POST /uploads/signature`, then attach the file to the listing. Photos are public; documents are private and open only through links that expire after 10 minutes.

- `UPLOAD_DRIVER=local` (default): files go to `UPLOAD_DIR` (`backend/.uploads`, ignored by git) and this API serves them at `/api/v1/files`, with `API_PUBLIC_URL` in their links. Development only: it refuses uploads in production (503 `UPLOADS_UNAVAILABLE`).
- `UPLOAD_DRIVER=cloudinary`: signed direct uploads to Cloudinary (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`), which bypass the API and its WAF; documents are uploaded as private assets. Waiting for the client's account.

## Bookings and payments

- `POST /bookings` checks the Guest (verified mobile, licence details and the eligibility rules in settings) and the trip, then creates a `PAYMENT_PENDING` booking and holds its dates for 30 minutes (`booking.expirePaymentHold`).
- `POST /bookings/{id}/payment` records the Guest Agreement and creates the PaymentIntent in NZD: charged at once for Instant Book, or authorised only (manual capture) for a request. The card is saved for post-trip charges, and a customer session shows saved cards.
- Stripe's webhook and `POST /bookings/{id}/payment/sync` (called by the website after Stripe.js confirms) apply the same function, so a booking is confirmed once, whichever arrives first. Locally there are no webhooks unless you run `stripe listen`, so the sync call is what updates the booking.
- A request waits 24 hours for the Host (`booking.expireRequest`); accepting captures the payment, declining releases it.
- Cancellations use the booking's own copy of its cancellation tier (`src/modules/bookings/policies.ts`): Guest cancellations refund by the tier, Host cancellations refund in full and add the Host cancellation fee to what the Host owes, and withdrawn requests release the authorisation. `GET /bookings/{id}/cancellation-preview` shows the outcome first. Staff with `REFUNDS` cancel no-shows and platform cancellations at `/admin/bookings/{id}/cancel`.

## Notifications

`notify()` in `src/modules/notifications/notify.ts` writes the in-app notification (the header's bell, `GET /notifications`) and queues the email and, when asked, an SMS to a verified mobile (`notification.send`). It takes the caller's transaction, so a notification exists only if the change behind it commits, and a dedupe key, so a job that runs twice never notifies twice. Non-urgent SMS wait for the end of quiet hours (settings). SMS other than codes need `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER`; without one they're marked failed and logged.

## Roles and permissions

`requireRole('ADMIN', 'SUPPORT')` checks the roles in the access token. `requirePermission('REFUNDS')` checks a support staff member's extra rights, read from the database on each request so a removed permission stops working at once; admins have every permission (plan §6.2). Both run after `requireAuth`, and the admin portal also runs `requireActiveAccount`, so a suspended staff member loses access at once.

## API

The full contract, with every request and response shape, is [openapi.json](openapi.json) (plan §2.3). Each module describes its routes in `*.openapi.ts`. Phase 2 added search, places, vehicles, quotes, destinations, FAQs, legal pages, policies, featured reviews, the contact form, the Host application and onboarding, uploads, the calendar, bookings, checkout readiness, notifications and the staff approval queues (see the sections above). The table below covers accounts and sign-in.

| Route                                           | Access         | Notes                                                                                                                                                                                                      |
| ----------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                  | Public         | 200 when connected to MongoDB, 503 otherwise or while shutting down                                                                                                                                        |
| `POST /api/v1/auth/signup`                      | Public         | `{ firstName, lastName, email, password, acceptTerms: true }`. Creates a Guest, records the Terms and Privacy versions accepted, emails a confirmation link and signs in. 409 if the email has an account. |
| `POST /api/v1/auth/verify-email`                | Public         | `{ token }` from the emailed link (single use, 24 h). Sends the welcome email once confirmed.                                                                                                              |
| `POST /api/v1/auth/verify-email/resend`         | Signed in      | A new confirmation link; the old one stops working. 5 an hour.                                                                                                                                             |
| `POST /api/v1/auth/login`                       | Public         | `{ email, password, portal?: 'app' \| 'admin' }`. Sets `httpOnly` cookies. `portal: 'admin'` refuses non-staff accounts. Rate-limited, and sign-in locks for 15 min after 5 wrong passwords.               |
| `POST /api/v1/auth/session`                     | Public         | The website's page-load check: `{ user }` or `{ user: null }`, renewing an expired access token                                                                                                            |
| `POST /api/v1/auth/login/mfa`                   | Challenge      | Staff: `{ challenge, code }` after the password step answered `mfaRequired`. Each authenticator code works once; 5 wrong codes end the attempt.                                                            |
| `POST /api/v1/auth/forgot-password`             | Public         | `{ email }`. Emails a reset link (1 h) if the account exists; always 204.                                                                                                                                  |
| `POST /api/v1/auth/reset-password`              | Public         | `{ token, password }`. Signs out every device and emails "Password changed". Doesn't sign in.                                                                                                              |
| `POST /api/v1/auth/confirm-email-change`        | Public         | `{ token }` from the link sent to a new address; the old address is told.                                                                                                                                  |
| `POST /api/v1/auth/phone/otp` · `/phone/verify` | Signed in      | `{ phone }` texts a code (Twilio Verify; `SMS_DRIVER=console` logs it locally), then `{ code }` verifies the number. NZ numbers without +64; overseas with their code.                                     |
| `POST /api/v1/me/password`                      | Signed in      | `{ currentPassword, newPassword }`. Signs out other devices.                                                                                                                                               |
| `POST /api/v1/me/email`                         | Signed in      | `{ newEmail, currentPassword }`. Emails a link to the new address; the old one works until it's opened.                                                                                                    |
| `GET /api/v1/me/mfa`                            | Staff          | Whether two-factor sign-in is on, and the authenticator apps (up to 2, never their secrets). Optional for staff; each turns it on or off in the staff portal's Settings.                                   |
| `POST /api/v1/me/mfa/setup` · `/me/mfa/verify`  | Staff          | Adds an authenticator app: a QR code, then `{ code, name? }` from it. The first turns two-factor on and signs out other devices; a second also needs `currentCode` from the first.                         |
| `POST /api/v1/me/mfa/devices/:id/remove`        | Staff          | `{ code }` from either app. Removes one of two apps; 409 `MFA_LAST_DEVICE` for the last one.                                                                                                               |
| `POST /api/v1/me/mfa/disable`                   | Staff          | `{ code }` from any app. Turns two-factor sign-in off and removes every app. Each of these changes emails the staff member.                                                                                |
| `POST /api/v1/admin/staff/:id/mfa/reset`        | Admin          | Removes another staff member's lost authenticator apps and signs them out. Audit-logged.                                                                                                                   |
| `POST /api/v1/auth/refresh`                     | Refresh cookie | Rotates the refresh token (each works once)                                                                                                                                                                |
| `POST /api/v1/auth/logout`                      | Any            | Ends the session and clears the cookies                                                                                                                                                                    |
| `POST /api/v1/me/agreements`                    | Signed in      | `{ types }`, e.g. `['TERMS', 'PRIVACY']`: accepts the current version of those documents, with the time and IP. The user's `pendingAgreements` lists the ones with a new version to accept.                |
| `GET /api/v1/me`                                | Signed in      | The signed-in user                                                                                                                                                                                         |
| `GET /api/v1/admin/overview`                    | Admin, Support | KPI figures; `null` for metrics whose module isn't built yet                                                                                                                                               |

Staff who lose their authenticator and can't reach another admin: re-running `npm run create-admin` for their email removes it (and resets the password), so they can set up a new one. Security-relevant changes (password, email, phone, authenticator) and every staff write go to the append-only `auditLogs` collection.

Errors always look like `{ error: { code, message, fields? } }`. Requests that change data must come from an origin in `FRONTEND_ORIGINS` (CSRF protection, plan §14).

## Folder map

```
src/
  app.ts            Express app (middleware, routes)
  server.ts         Starts the API, Socket.IO and the job runner in one process, with graceful shutdown
  env.ts            Environment variables, validated with Zod at startup
  db.ts             Mongoose connection (sanitizeFilter + strictQuery against NoSQL injection), withTransaction()
  models.ts         Every Mongoose model, for the index sync
  middleware/       auth (requireAuth, requireRole, requirePermission), CSRF origin check, rate limit (MongoDB store), error handler
  modules/          One folder per domain: *.model.ts, *.schemas.ts, *.service.ts, *.routes.ts, *.openapi.ts
    auth/ users/ admin/ audit/ hosts/          accounts, staff, the Host application
    search/ vehicles/ pricing/ availability/   search, listings, onboarding, the pricing engine, the calendar
    bookings/ payments/ notifications/         the booking flow, Stripe, policies, notify()
    cms/ support/ uploads/ currency/           public content, the contact form, uploads, exchange rates
    payouts/ messages/ reviews/ inspections/ incidents/ moderation/ help/   models only, until Phase 3
  jobs/             Job queue: job.model.ts, queue.ts, runner.ts, handlers/ (one per job type)
  realtime/         Socket.IO server, auth and MongoDB adapter
  pages/            Page tags for vehicle and destination pages, and sitemap.xml (/pages)
  openapi/          Builds the API contract from each module's *.openapi.ts
  integrations/     logger, mailer (Resend + console), SMS (Twilio Verify and Messages + console), Stripe,
                    places (Google Places + local), storage (Cloudinary + local)
  emails/           React Email templates, shared layout and brand theme
  lib/              HttpError, validation helper, lifecycle, shared model field types, NZD formatter
scripts/            seed.ts (+ seed-data/), sync-indexes.ts, create-admin.ts, send-test-email.ts, email-preview.ts, openapi.ts
test/               API tests (Vitest + Supertest + mongodb-memory-server)
```
