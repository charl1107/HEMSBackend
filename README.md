# HEMS Backend

REST API for the Hospitality Management Event System (HEMS). Built with NestJS 12, Prisma 6, and PostgreSQL. Pairs with the Vue 3 frontend in `../HEMSFrontend`.

## Features

- **Auth** — JWT access tokens + refresh-token rotation (hashed at rest), bcrypt password hashing, forced password change flow, login rate-limited to 10 req/min per IP
- **Events** — CRUD with status workflow (`Planning → Ongoing → Completed / Cancelled`), event types, on/off-campus scope, cover images, public catalog endpoints
- **Roles** — `Admin`, `Department Head`, `Event Coordinator`, `Instructor`, `Student Officer`, `Student`; enforced per-route with a `@Roles()` decorator
- **Notifications** — event submitted/approved/rejected, revision requested, task assigned
- **Reports** — aggregate reporting endpoints for the frontend reports dashboard
- **Audit log** — request-level audit trail (method, path, body, status, user), viewable by admins
- **Security** — Helmet, CORS allowlist, throttling, validation via class-validator (see `src/security.ts`)

## Project structure

```
src/
  auth/           JWT strategy, login/refresh/logout, guards
  users/          User CRUD, roles, student directory
  events/         Events, public catalog, cover uploads
  notifications/  User notifications
  reports/        Reporting aggregates
  audit/          Audit log queries
  health/         Health check endpoint
  prisma/         PrismaService module
  common/         Shared decorators/guards (e.g. @Roles)
  security.ts     App hardening (helmet, CORS, throttler)
prisma/
  schema.prisma   Data model
  seed.ts         Seeds roles (+ admin if env vars set)
```

Legacy tables (participants, attendance, approvals, tasks, schedules, committees, documents) are kept for data compatibility but are not used by the current app — see `prisma/schema.prisma` comments.

## Setup

```bash
npm install            # also runs `prisma generate` via postinstall
cp .env.example .env   # then fill in real values
```

Required env vars (see `.env.example` for the full list and comments):

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | PostgreSQL connection strings (Prisma) |
| `JWT_SECRET` | Required; rejects empty/placeholder values in all environments |
| `FRONTEND_URL` | Comma-separated CORS allowlist; **required in production**, `*` is rejected |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Optional; enables admin provisioning in the seed |

## Database

```bash
npx prisma migrate dev      # apply migrations in development
npm run prisma:deploy       # apply migrations in production
npx prisma db seed          # seed roles (+ admin if SEED_ADMIN_* is set)
```

## Running

```bash
npm run start:dev    # watch mode (http://localhost:3000)
npm run build        # compile to dist/
npm run start:prod   # prisma generate + migrate deploy + run dist/main
```

## Tests & linting

```bash
npm test             # unit tests (Vitest)
npm run test:e2e     # end-to-end tests
npm run test:cov     # coverage
npm run lint         # oxlint (type-aware)
npm run format       # prettier
```

## Deployment

```bash
npm run deploy       # @nestjs/mau
```

HTTPS/TLS termination is handled at the deploy platform (Vercel/ingress) — enable it at deploy time, not in this app.
