# Putting Production Costing online (hosted, for paying clients)

This is the checklist for running it as a service: you host it once, each client business logs in with their own account, and their data is kept apart from everyone else's. **None of this has been tried on a real hosting provider yet.** The app itself is tested (automated tests and a real-browser run through the whole flow); the steps below are the standard way to run a Node app and have not been rehearsed on a host. Do a trial deployment with fake data first.

## What you need

1. **A PostgreSQL 16 database** from a managed provider (the host's own database add-on, or a database-only service). Pick one with **automatic daily backups**, that is the single most important protection for your clients' data.
2. **Somewhere to run the app**: any host that runs a Docker image or a Node 22 app and puts HTTPS in front (Render, Railway, Fly.io, a small VPS with Caddy or nginx, and so on). The app needs a public address that starts with `https://`.
3. **A domain name** (optional but you want one, for example `costing.yourbrand.ph`).

Rough running cost is a small server plus a small database, roughly the price of a couple of lunches a month at the low end; check the providers' current prices yourself.

## Settings (environment variables)

| Setting | Value | Why |
| --- | --- | --- |
| `DATABASE_URL` | the PostgreSQL address your provider gives you | Required. The built-in database is only for your own computer: its files would sit on the host's disk, which is wiped on every deploy. With `NODE_ENV=production` (or on Render) and no `DATABASE_URL`, or one that is not a PostgreSQL address, the app refuses to start. |
| `NODE_ENV` | `production` | Required. Turns on secure cookies, and makes the app (and backup/restore) refuse to start without a real database in `DATABASE_URL`. The Dockerfile sets it; on a plain Node host set it yourself. Never set it on your own computer with the built-in database. (On Render the database check also runs without it, because Render sets `RENDER=true`, but secure cookies still need `NODE_ENV`; the app prints a warning in the log if it is missing there.) |
| `APP_ORIGIN` | `https://your-address` (no trailing slash) | Used in the invitation links you copy. |
| `TRUST_PROXY` | `true` | The host's HTTPS proxy sits in front; needed so the sign-in attempt limit sees each visitor. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | yours, password at least 10 characters | Creates **your** platform-admin account on first start. Sign in, then **delete these two settings**. |
| `HOST` / `PORT` | `0.0.0.0` / `3001` | The Dockerfile sets these already. Some hosts give you a `PORT`; the app uses it. |

The database user in `DATABASE_URL` must be allowed to create a role (the app creates a restricted role called `costing_app` and uses it for every business's requests, which is how businesses are kept apart). Most managed providers' main user can. If yours cannot, the app refuses to start and says why; it never runs with the separation switched off.

**Secure connection setting.** If your provider asks for a secure connection, end the address with `?sslmode=verify-full`. If the address they give you ends in `sslmode=require`, change that to `sslmode=verify-full`: the protection is the same today (the connection is encrypted and the database's certificate is checked), the database driver no longer prints a "SECURITY WARNING" at every start, and the certificate stays checked when the driver is upgraded later. Otherwise use the address exactly as your provider shows it. (If the address already contains a `?`, add `&sslmode=verify-full` instead.) For `psql` or `pg_dump`, use the address exactly as your provider shows it: those tools treat `verify-full` more strictly and need extra certificate setup (or add `sslrootcert=system` with PostgreSQL 16 or newer tools).

## Steps

1. Create the database and copy its connection address.
2. Create the app on your host from this folder (Docker: the included `Dockerfile` builds it; or a Node host: build command `npm ci && npm run build`, start command `npm run start -w server`). Set the settings above.
   If the app does not come up, read the host's log: a wrong or unreachable database shows as "Cannot reach the database at ..." with the reason (refused, address not found, password not accepted, and so on).
3. Open `https://your-address`. You should see the sign-in page. Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then remove those two settings and redeploy/restart.
4. **Businesses** page: add your own siomai business first as a test client. Copy the invitation link it shows, open it in a private window, choose a password, and record a run.
5. For each new client: add the business, copy the link, and send it to them yourself (chat or text). Links work once and last 7 days. No email is sent by the app. A forgotten password is the same: open the business, press **Reset password link**, send the link.

## Taking money

Start manually. Quote a monthly price, receive GCash, bank transfer or cash, and press **Record payment** on the business: enter the amount, the reference and how many months it covers. Access extends automatically, and a week after the paid-through date (grace period) the business becomes **read-only**: they can still look at everything, and the owner can download their data, but they cannot add or change anything, until you record the next payment. **Suspended** locks a business out completely (for example a dispute).

Automatic monthly charging is a later step (PayMongo supports recurring payments by card and Maya, not GCash, as far as I could find). Do it only once you have a few paying clients and the manual routine gets annoying.

## Backups

- Turn on your database provider's **automatic backups** and test restoring one at least once.
- You can also take a whole-service copy yourself with `npm run backup` (needs the same `DATABASE_URL` set). It includes every business's data and the password hashes, so **keep the file private**. `npm run restore -- <file> --yes` puts it back and signs everyone out.
- Each business's owner can download its data from **Account → Download my data**, even when it has lapsed. Staff cannot, because the file holds every cost and margin.

## Before you take real clients

- **Security review.** Sign-in is built with Node's standard cryptography (scrypt password hashing, server-side sessions, rate limiting), and business separation is enforced by the database itself and tested. Even so, it was built by an AI assistant and has not been reviewed by a person who audits security. Before real money or sensitive data, have a developer or security reviewer look at the `server/src/auth` folder, the migrations and the deploy settings.
- **Terms and privacy.** Have simple terms of service (what you promise, what you do not, how a client leaves and takes their data) and a short privacy notice. You will be holding your clients' business data and their staff's names and emails, so the Philippine Data Privacy Act applies; the National Privacy Commission's guidance on registration thresholds is worth reading.
- **Taxes and business registration.** Selling a subscription means a registered business, BIR registration and receipts for what you charge. Ask an accountant.
- **Support.** Decide who clients contact and how fast you reply. The app only says "contact the person who runs this service".

## Updating

Deploy the new version over the old one. Database changes are applied automatically at start (files in `server/migrations`), in order, once each. Take a backup first. A backup can only be restored by the app version that made it, into a database that a newer version has not upgraded yet. Once the new version has started, the database stays on the new version, so to use an older backup: create a new, empty PostgreSQL database, restore the backup into it with the older version (`DATABASE_URL` pointing at the new database), then point the new version at that database and start it: it upgrades the data automatically.
