# Battlemage Benchmarks

Independent benchmarking of Intel Arc B70 and B65 GPUs — Vulkan vs SYCL,
llama.cpp vs vLLM. Not affiliated with Intel Corporation.

Server-rendered Node.js/Express/EJS app backed by SQLite. Pages render live
from the database on every request — there's no separate build/regeneration
step, so approving a submission makes it public immediately.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- `SESSION_SECRET` — set to a long random string, e.g.
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `ADMIN_PASSWORD_HASH` — generate with:
  ```bash
  npm run hash-password
  ```
  It prompts for a password and prints a bcrypt hash to paste into `.env`.
  The plaintext password is never written to disk.

Run the dev server (auto-restarts on file changes):

```bash
npm run dev
```

Or for production:

```bash
npm start
```

By default it listens on `http://localhost:3000` (`PORT` in `.env`).

## How it works

- **Public pages** (`/`, `/results`, `/configs/:card/:backend/:runtime`,
  `/compare`, `/recipes`, `/methodology`) only ever show
  `status = 'verified'` rows.
- **`/recipes`** publishes the curated launch scripts from `recipes/` — three
  profiles (performance / balanced / context) per runtime and backend. These
  are the same files the benchmark runner sources, so the script a reader
  copies is the script that produced the numbers offered as evidence for it.
- **`/submit`** takes a public submission — including a copyable prompt for
  handing off to your own AI agent to gather system/software details and
  benchmark output as JSON, which a "paste from agent" box on that page can
  auto-fill into the form. Every submission lands as `status = 'pending'`.
- **`/admin`** (password-protected) lists the pending queue. Approving a
  submission flips it to `verified` and it appears on the public pages on
  the very next request — no rebuild needed. Rejecting sets it to
  `rejected` and it never appears publicly.

The admin session uses an in-memory store, so restarting the server logs
you out — expected at this scale; re-login via `/admin/login`.

## Benchmarking

Running the sweep is a separate job from running the site:

- **`docs/SETUP.md`** — preparing a benchmark machine: drivers, two llama.cpp
  builds, the vLLM XPU environment, card selection, power measurement, models.
  Each step ends with a command that proves it worked.
- **`recipes/`** — the launch scripts. Also the site's actual recommendations,
  published at `/recipes`.
- **`scripts/bench/`** — the runner. See its README for the axes and how a
  number is computed; `REMOTE_AGENT_PROMPT.md` there is a self-contained brief
  for an agent driving the sweep on the GPU machine.

A full sweep of the three benchmarked models is ~540 cells and 2,160 timed
runs, well over a day of wall time — use `--resume`.

## Self-hosting

This is a plain Node process — run it behind whatever reverse proxy you
already use (nginx, Caddy, etc.) for TLS termination and a real domain.

If you do put it behind a reverse proxy:
- Set `NODE_ENV=production` in `.env` — this enables `secure` session
  cookies and `trust proxy`.
- Make sure the proxy forwards `X-Forwarded-*` headers correctly, or secure
  cookies (and therefore admin login) won't work.

Process management (pick one): `pm2 start server.js --name battlemage`,
or a `systemd` unit running `node server.js` with `Restart=on-failure`.

The SQLite file lives at `data/battlemage.db` (path configurable via
`DB_PATH`) — back it up like any other file; there's no separate database
server to manage.

## Project layout

```
server.js              entry point
src/
  app.js                Express app: middleware, view engine, routes
  config.js              env var loading/validation
  db.js                   SQLite connection + migration runner
  schema.sql               table definitions
  middleware/requireAdmin.js
  routes/                    index, results, configs, compare, recipes,
                             methodology, submit, admin
  lib/                        constants, queries (all SQL), validate, format,
                              agentPrompt, recipes
views/                  EJS templates (views/admin/ for the admin panel)
public/                 static CSS/JS served as-is
recipes/                the published launch scripts — also what the runner uses
docs/SETUP.md           preparing a benchmark machine
scripts/bench/          the benchmark runner + the remote-agent brief
scripts/hash-password.js  one-time admin password hash generator
data/                   battlemage.db lives here at runtime (gitignored)
```

## Adding a schema change later

Add a new `{ version, up }` entry to the `migrations` array in `src/db.js`
(never edit an already-shipped one) — it's applied automatically via
`PRAGMA user_version` the next time the server starts.
