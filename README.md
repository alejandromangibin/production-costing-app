# Production Costing

A small web app that replaces the notebook for a food maker. For each production run it records what was made, shares the costs fairly between products, and tells you the cost, margin and markup of every pack size, with batch codes and expiry dates.

It now has **logins and separate accounts per business**, so it can run as an online service for several businesses (each sees only its own data), or on your own computer for trying it out.

- Putting it online for clients: read **DEPLOY.md**.
- Trying it on your own computer: below.

## First sign-in on your own computer

There is no public sign-up. The first time, you create your own platform-admin sign-in:

1. Copy `.env.example` to `.env` (in PowerShell: `copy .env.example .env`).
2. Remove the `#` in front of `ADMIN_EMAIL` and `ADMIN_PASSWORD` and fill in your email and a password of at least 10 characters.
3. Start the app (below), open http://localhost:3001 and sign in. Then delete those two lines from `.env`.
4. On **Businesses**, add your own business. The app shows an invitation link; open it, choose a password, and you are in as that business's owner. (Add more businesses the same way; each is separate.)

## Run it (Windows)

1. Install **Node.js** (the LTS version) from https://nodejs.org if you do not have it. You can check with `node --version` in PowerShell (version 22 or newer is best).
2. Open this folder and **double-click `start-app.bat`**.
   - The first time it installs what it needs (a few minutes, needs internet).
   - Your browser opens at http://localhost:3001 after about 15 seconds.
3. Keep the black window open while you use the app. Close it to stop the app.

Or, in PowerShell inside this folder:

```powershell
npm install        # first time only
npm start          # builds the screens and starts the app
```

Then open http://localhost:3001.

### Mac or Linux

```bash
npm install
npm start
```

## Using it

1. **Products**: add each product (short code, shelf life in days) and the pack sizes you sell, with the retail price and the packaging cost per pack. 12 pieces is just one pack size; add 6, 20, 50 or any other.
2. **New run**: pick the date, add the products made, then for each enter packs per size, loose pieces and rejected pieces. Add the costs of the run:
   - **Shared** costs (base ingredients, gas, electricity, labor) are split between all products by pieces made.
   - **Specific** costs (an ingredient only one product uses) go only to the products you tick.
   The review table updates as you type. Check it, then Save.
3. **History**: all runs, with filters and a CSV download for Excel.
4. **Expiry**: batches by expiry date, soonest first, with a warning window you can change.
5. **Margins**: latest cost per pack versus today's price.
6. **Team** (owner only): add staff with their own sign-ins; copy the invitation link and send it to them yourself.
7. **Account**: change your password, see the subscription state, and **download all your business's data** at any time.

A saved run cannot be edited, so old figures never change quietly. If you made a mistake, **void** the run (it stays in History but is left out of reports) and enter it again.

## How the costing works

- Pieces made = packed pieces + loose pieces + rejected pieces. Good pieces = pieces made − rejected.
- Shared costs are split by pieces made. A leftover centavo goes to the first product in the run, so the shares always add up exactly.
- Cost per pack = (a product's share of costs × pieces in the pack ÷ good pieces) + packaging for one pack, rounded to the centavo once.
- Margin = (price − cost) ÷ price. Markup = (price − cost) ÷ cost.

Worked example (also an automated test): shared ₱2,800 and a Japanese-only cost of ₱600 across 250 Pork and 750 Japanese pieces gives a Pork 12-piece pack cost of ₱39.15 (margin 44.1%).

## Subscriptions in one minute

Each business is on a free trial, then paid months that you record by hand on the **Businesses** page (amount, how they paid, months covered). A week after the paid-through date the business turns **read-only**: it can still look at everything and download its data, but cannot add or change anything until you record the next payment. **Suspended** locks it out completely. Nothing is charged automatically.

## Backup and restore

- Each business downloads its own data from **Account**.
- You, the operator, copy the whole service (all businesses and sign-ins) from the command line. On a hosted database also turn on the provider's automatic backups. In PowerShell, in this folder:

```powershell
npm run backup                                   # saves into the "backups" folder
npm run restore -- backups\costing-backup-2026-10-19.json --yes
```

Restoring replaces everything in the database with the backup and signs everyone out. Backup files contain every business's data and the password hashes: keep them private. With the built-in database, close the app first; your live data is in `server\.data`. A backup can only be restored by the app version that made it. To use an older backup, restore it with that version, then start the new version: it upgrades the data automatically.

## Settings

Copy `.env.example` to `.env` and edit it. The file explains each line; the main ones are below. DEPLOY.md lists what to set for a hosted service.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | 3001 | Port the app uses |
| `HOST` | 127.0.0.1 | Only this computer can open it. Use `0.0.0.0` to open it from a phone on the same Wi-Fi (anyone on that Wi-Fi could then see your data) |
| `DATABASE_URL` | empty | Leave empty for the built-in database. Set to a PostgreSQL address to use a real PostgreSQL server (`docker compose up -d` starts one, see `.env.example`). Required when `NODE_ENV` is `production` or the app runs on Render: it refuses to start without it |
| `DATA_DIR` | `.data` | Where the built-in database is stored, inside `server` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | empty | Creates the platform-admin sign-in on first start. Delete them afterwards |
| `APP_TIME_ZONE` | Asia/Manila | Decides what "today" is for trial ends, payment due dates, new trials, days left on the expiry board, and download and backup file names, whatever the server's own clock is set to |
| `APP_ORIGIN` | empty | The public https address; used in invitation links |
| `NODE_ENV` | empty | Required as `production` when hosted: secure cookies, and the app refuses to start without `DATABASE_URL`. Leave it empty on your own computer |
| `TRUST_PROXY` | false | `true` behind a host's HTTPS proxy |

## For developers

```bash
npm run dev         # server with auto-restart (3001) + web dev server with hot reload (5173)
npm test            # calculation and API tests
npm run typecheck
npm run build       # production build of the web app into web/dist
```

- `server/src/calc` is the only place costs are calculated (integer centavos, BigInt for splitting). The screens show what the server returns.
- Businesses are kept apart by the database itself: every business-owned table has a `tenant_id` and PostgreSQL row-level security, and each request runs as a restricted database role that can only see its own business's rows. The app checks this at start and refuses to run if it is off. `server/tests/tenancy.test.ts` tries to break it.
- `server/migrations` holds the database schema as plain SQL; new files are applied automatically on start.
- Stack: React + Vite + TypeScript; Node + Express + Zod; PostgreSQL (the built-in database is PGlite, PostgreSQL running inside Node).

## Limits of this version

- No email is sent: invitation and password-reset links are copied from the screen and sent by you.
- Payments are recorded by hand; there is no automatic charging.
- A security review by a person is recommended before real clients and real money (see DEPLOY.md).
- It does not track stock, issue receipts or invoices, or give food-safety or labelling advice. Expiry dates are the dates you choose to record.
- Tested on Linux (automated tests, and a real browser). Not yet run on Windows or on a hosting provider.
