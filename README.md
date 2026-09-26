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
npm run seed            # creates the demo accounts below
npm run dev             # API on http://localhost:4000
```

`MONGODB_URI` points at your MongoDB cluster (include a database name, e.g. `.../rento-vroom-dev`). Docker is not needed.

**`querySrv ECONNREFUSED` when connecting?** Node can't reach a DNS server to look up the `mongodb+srv://` address (common on Windows, where Node sometimes falls back to `127.0.0.1`). Add `DNS_SERVERS=8.8.8.8,1.1.1.1` to `.env`. If it still fails, check that your IP address is allowed under Network Access in MongoDB Atlas.

Demo accounts from `npm run seed` (password: your `SEED_DEMO_PASSWORD`). The seed refuses to run in production.

| Account                   | Roles        |
| ------------------------- | ------------ |
| `admin@rentovroom.test`   | Admin        |
| `support@rentovroom.test` | Support      |
| `host@rentovroom.test`    | Guest + Host |
| `guest@rentovroom.test`   | Guest        |

## Commands

| Command                                           | What it does                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                     | API with reload on change (`tsx watch`)                                                                              |
| `npm run build` / `npm start`                     | Bundle to `dist/` with tsup / run the bundle with plain `node`                                                       |
| `npm run lint` · `npm run typecheck` · `npm test` | Checks. Tests use an in-memory MongoDB, so they never touch your cluster (the first run downloads a MongoDB binary). |
| `npm run seed`                                    | Demo accounts (not in production)                                                                                    |
| `npm run create-admin`                            | Creates or resets a staff account, also in production (the first admin). Inputs in `scripts/create-admin.ts`         |
| `npm run email:test -- you@example.com`           | Sends the welcome email through the configured mailer                                                                |
| `npm run format`                                  | Prettier                                                                                                             |

## Email

Emails are React Email templates in `src/emails`, sent through the `Mailer` interface in `src/integrations/mailer` (plan §7):

- `MAIL_DRIVER=console` (default): nothing is sent. Each email's subject and links are logged and the HTML is saved to `backend/.mail/`.
- `MAIL_DRIVER=resend`: sends through [Resend](https://resend.com). Needs `RESEND_API_KEY` and an `EMAIL_FROM` address on a domain verified in Resend.

Add a template in `src/emails/templates/` and register it in `emailTemplates` (`src/emails/index.ts`); `sendEmail({ to, template, props })` is then type-checked against its props.

## API so far

| Route                        | Access         | Notes                                                                                                                                                                                        |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`               | Public         | 200 when connected to MongoDB, 503 otherwise or while shutting down                                                                                                                          |
| `POST /api/v1/auth/login`    | Public         | `{ email, password, portal?: 'app' \| 'admin' }`. Sets `httpOnly` cookies. `portal: 'admin'` refuses non-staff accounts. Rate-limited, and sign-in locks for 15 min after 5 wrong passwords. |
| `POST /api/v1/auth/session`  | Public         | The website's page-load check: `{ user }` or `{ user: null }`, renewing an expired access token                                                                                              |
| `POST /api/v1/auth/refresh`  | Refresh cookie | Rotates the refresh token (each works once)                                                                                                                                                  |
| `POST /api/v1/auth/logout`   | Any            | Ends the session and clears the cookies                                                                                                                                                      |
| `GET /api/v1/me`             | Signed in      | The signed-in user                                                                                                                                                                           |
| `GET /api/v1/admin/overview` | Admin, Support | KPI figures; `null` for metrics whose module isn't built yet                                                                                                                                 |

Errors always look like `{ error: { code, message, fields? } }`. Requests that change data must come from an origin in `FRONTEND_ORIGINS` (CSRF protection, plan §14).

## Folder map

```
src/
  app.ts            Express app (middleware, routes); server.ts starts it with graceful shutdown
  env.ts            Environment variables, validated with Zod at startup
  db.ts             Mongoose connection (sanitizeFilter + strictQuery against NoSQL injection)
  middleware/       auth (requireAuth, requireRole), CSRF origin check, rate limit, error handler
  modules/          One folder per domain: *.model.ts, *.schemas.ts, *.service.ts, *.routes.ts
    auth/ users/ admin/
  integrations/     logger, mailer (Resend + console)
  emails/           React Email templates, shared layout and brand theme
  lib/              HttpError, validation helper, lifecycle
scripts/            seed.ts, send-test-email.ts
test/               API tests (Vitest + Supertest + mongodb-memory-server)
```
