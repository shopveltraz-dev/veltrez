# Deploying VELTREZ

Free-tier stack: **Render** (web service) + **Supabase Storage**
(DB snapshot + uploaded product photos) + a **GitHub Actions keepalive** that
stops both free tiers from going to sleep permanently.

## 1. GitHub

Repo: `shopveltraz-dev/veltrez`. Render auto-deploys on every push to `main`.

## 2. Supabase (persistence)

Render's free disk is wiped on every deploy/restart. Without Supabase the
database (orders!) resets every time.

1. Create a project at https://supabase.com (free tier).
2. Project Settings → API: copy the **URL** and the **service_role key**.
3. Set them in Render as `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.

Buckets (`veltrez` public for photos, `veltrez-private` for the DB snapshot)
are created automatically on first boot.

## 3. Render

1. https://dashboard.render.com → New → **Blueprint**, pick the GitHub repo.
   `render.yaml` defines the free web service (health check on `/api/health`).
2. Fill in `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` when prompted.
3. First deploy log prints the **admin password once** — save it, log into
   `/admin.html`, change it. If lost later: set `ADMIN_RESET=anything`,
   redeploy, read the new password from the log, delete the variable.

## 4. Keepalive (the wake-up bot)

Supabase pauses a free project after ~7 days idle; a paused project takes the
whole site down on next boot. `.github/workflows/keepalive.yml` pings
`/api/keepalive` every 3 days, which makes the server do a real Supabase
request — resetting both Render's and Supabase's idle clocks.

GitHub repo → Settings → Secrets and variables → Actions:

- `KEEPALIVE_URL` — `https://<your-render-host>.onrender.com/api/keepalive` (**required**)
- `KEEPALIVE_TOKEN` — optional; if set, set the same value as the
  `KEEPALIVE_TOKEN` env var in Render.

Test it: repo → Actions → keepalive → Run workflow.

## 5. Order-confirmation email (optional)

Without SMTP, order emails only print to the Render log. To actually send:
set in Render `EMAIL_PROVIDER=smtp`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`,
`SMTP_USER=<gmail address>`, `SMTP_PASS=<Gmail App Password>`, `SMTP_FROM`.
(App Passwords require 2-Step Verification on the Google account.)

## Local dev

```
npm install
node server.js     # http://localhost:8095, admin at /admin.html
```

Admin password prints on first run (stored in local veltrez.sqlite).
