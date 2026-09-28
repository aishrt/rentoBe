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

| Account                             | Roles        | Notes                  |
| ----------------------------------- | ------------ | ---------------------- |
| `admin@rentovroom.test`             | Admin        |                        |
| `support@rentovroom.test`           | Support      |                        |
| `host@rentovroom.test`              | Guest + Host | 4 cars in Auckland     |
| `host.wellington@rentovroom.test`   | Guest + Host | 4 cars in Wellington   |
| `host.christchurch@rentovroom.test` | Guest + Host | 4 cars in Christchurch |
| `host.queenstown@rentovroom.test`   | Guest + Host | 4 cars in Queenstown   |
| `host.rotorua@rentovroom.test`      | Guest + Host | 4 cars in Rotorua      |
| `guest@rentovroom.test`             | Guest        | Past trips and reviews |
| `visitor@rentovroom.test`           | Guest        | Past trips and reviews |
| `guest2@rentovroom.test`            | Guest        | Past trips and reviews |

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
| `npm run email:test -- you@example.com`           | Sends the welcome email through the configured mailer                                                                                                                        |
| `npm run format`                                  | Prettier                                                                                                                                                                     |

## Data model

Every collection in plan §3 has a Mongoose model in its module (`src/modules/<module>/<name>.model.ts`), and `src/models.ts` lists them all.

- Shared field types are in `src/lib/model-fields.ts`: money as whole NZD cents (`cents()`), GeoJSON points (`[longitude, latitude]`), the structured NZ address and star ratings.
- Indexes are declared in the schemas. Mongoose builds a model's indexes when it's first used; `npm run db:indexes` syncs every collection at once.
- Schema changes are additive: a new field is optional or has a default, so existing documents keep working without a migration.
- Platform settings (fees, cancellation tiers, protection plans, eligibility, review windows and more) come from `getPlatformSettings()` in `src/modules/admin/platform-settings.service.ts`: what admins saved, over the launch defaults in `default-settings.ts`. The defaults are placeholders until the client decides (plan §16).
- Filters with operators need `mongoose.trusted()`, because `sanitizeFilter` is on (see `src/db.ts`).

## Email

Emails are React Email templates in `src/emails`, sent through the `Mailer` interface in `src/integrations/mailer` (plan §7):

- `MAIL_DRIVER=console` (default): nothing is sent. Each email's subject and links are logged and the HTML is saved to `backend/.mail/`.
- `MAIL_DRIVER=resend`: sends through [Resend](https://resend.com). Needs `RESEND_API_KEY` and an `EMAIL_FROM` address on a domain verified in Resend.

Add a template in `src/emails/templates/` and register it in `emailTemplates` (`src/emails/index.ts`). Features send it through the job queue, `enqueue('email.send', { to, template, props })`, which is type-checked against the template's props and retried if sending fails.

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

## API so far

The full contract, with every request and response shape, is [openapi.json](openapi.json) (plan §2.3). Each module describes its routes in `*.openapi.ts`.

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
| `POST /api/v1/me/mfa/setup` · `/me/mfa/verify`  | Staff          | Authenticator app setup: a QR code, then the first code. The staff portal answers 403 `MFA_SETUP_REQUIRED` until it's done.                                                                                |
| `POST /api/v1/admin/staff/:id/mfa/reset`        | Admin          | Resets another staff member's lost authenticator and signs them out. Audit-logged.                                                                                                                         |
| `POST /api/v1/auth/refresh`                     | Refresh cookie | Rotates the refresh token (each works once)                                                                                                                                                                |
| `POST /api/v1/auth/logout`                      | Any            | Ends the session and clears the cookies                                                                                                                                                                    |
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
  middleware/       auth (requireAuth, requireRole), CSRF origin check, rate limit (MongoDB store), error handler
  modules/          One folder per domain: *.model.ts, *.schemas.ts, *.service.ts, *.routes.ts, *.openapi.ts
    auth/ users/ admin/ audit/                 routes and services so far
    vehicles/ availability/ bookings/ payments/ payouts/ messages/ reviews/ inspections/
    incidents/ moderation/ support/ help/ notifications/ cms/ search/   models only, until their features are built
  jobs/             Job queue: job.model.ts, queue.ts, runner.ts, handlers/ (one per job type)
  realtime/         Socket.IO server, auth and MongoDB adapter
  openapi/          Builds the API contract from each module's *.openapi.ts
  integrations/     logger, mailer (Resend + console), SMS (Twilio Verify + console)
  emails/           React Email templates, shared layout and brand theme
  lib/              HttpError, validation helper, lifecycle, shared model field types
scripts/            seed.ts (+ seed-data/), sync-indexes.ts, create-admin.ts, send-test-email.ts, openapi.ts
test/               API tests (Vitest + Supertest + mongodb-memory-server)
```
