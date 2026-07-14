# Running a QA environment (qa.eve-nexum.com)

A second, isolated Nexum instance running **alongside prod on the same host**,
sharing the existing Traefik reverse proxy. QA gets its own database, its own
sessions, and its own EVE SSO app — nothing crosses over to prod.

## Why it's isolated (no shared state with prod)

- **Database:** the Postgres volume is scoped to the compose project name, so a
  distinct project name (`nexum-qa`) gives QA a brand-new, separate database.
- **Sessions:** the session cookie has no explicit domain, so it's host-scoped —
  `qa.eve-nexum.com` and `eve-nexum.com` logins don't collide.
- **Discord:** webhooks live in the DB (per-org), so a fresh QA DB posts nowhere
  until you configure it in the QA admin UI.
- **Traefik:** router/service/middleware names are prefixed by `${STACK}`, so
  `STACK=eve-nexum-qa` avoids colliding with prod's `eve-nexum` names.

## One-time setup

1. **DNS** — add an `A` record: `qa.eve-nexum.com` -> the server's IP (same box
   as prod). Traefik will fetch a Let's Encrypt cert for it automatically on
   first request.

2. **EVE SSO** — create a *separate* application on
   https://developers.eveonline.com with:
   - Callback URL: `https://qa.eve-nexum.com/auth/callback`
   - The same scopes as the prod app.
   Note its **Client ID** and **Secret** for the QA `.env` below.

3. **QA env file** — on the server, in a separate checkout/dir for QA, copy
   `.env.example` to `.env` and set (at minimum) the values that MUST differ
   from prod:

   ```dotenv
   # Second-instance identity (must differ from prod)
   COMPOSE_PROJECT_NAME=nexum-qa
   STACK=eve-nexum-qa
   DOMAIN=qa.eve-nexum.com
   FRONTEND_URL=https://qa.eve-nexum.com
   EVE_CALLBACK_URL=https://qa.eve-nexum.com/auth/callback

   # QA's own EVE SSO app (step 2)
   EVE_CLIENT_ID=<qa app client id>
   EVE_CLIENT_SECRET=<qa app secret>

   # Fresh secrets for QA (do NOT reuse prod's)
   SESSION_SECRET=<new random>
   TOKEN_ENCRYPTION_KEY=<new 32-byte key, as prod requires>
   PG_PASSWORD=<qa db password>
   ```

   Everything else (CORP_ID / ALLIANCE_ID / ADMIN_CHAR_ID / limits) can mirror
   prod or be set to QA-specific values as needed. Generate fresh secrets, e.g.
   `openssl rand -hex 32`.

## Deploy / update QA

From the QA checkout directory (with its own `.env`), always use **both** compose
files and the QA project name:

```bash
docker compose -p nexum-qa \
  -f docker-compose.yml -f docker-compose.traefik.yml \
  up -d --build
```

- `-p nexum-qa` keeps QA's containers, network and volumes separate from prod.
  (You can instead set `COMPOSE_PROJECT_NAME=nexum-qa` in `.env` and drop `-p`.)
- Same command redeploys after a `git pull` on the QA branch.
- The SDE import one-shot runs on first `up` and is skipped once populated.

To tear QA down (keeping prod untouched):

```bash
docker compose -p nexum-qa -f docker-compose.yml -f docker-compose.traefik.yml down
# add -v to also wipe the QA database volume
```

## Notes

- Prod is unaffected: with `STACK` unset it still defaults to `eve-nexum`.
- QA has no data by default — create maps/systems fresh, or seed as needed.
- The QA EVE app being separate means revoking/rotating it never touches prod.
