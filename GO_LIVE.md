# ScopeWalk — Go-Live Checklist

Deploys ScopeWalk to `https://scopewalk.cleanconstructionllc.com` as a single
Render web service (PWA + API + public proposal links, one origin), and links
it from the Clean Construction site's nav.

The app code is ready: the server serves the built PWA
([server/src/index.ts](server/src/index.ts)), and magic-link login emails send
via Resend ([server/src/auth.ts](server/src/auth.ts)). What's left is
infrastructure — DNS, the Render service, and secrets.

---

## 1. Render service

1. Render dashboard → **New → Blueprint** → connect the `remodelfieldtool` repo.
   It reads [render.yaml](render.yaml) and provisions the `scopewalk` service.
2. Add the secret env vars (marked `sync: false` in the blueprint) — copy the
   values from your local `.env`:
   - `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
   - `RESEND_API_KEY`  ← same key the marketing site uses
   - `GROQ_API_KEY`
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
   - `ANTHROPIC_API_KEY`
3. Deploy. Build runs `npm run build` (builds the PWA), pre-deploy runs the
   idempotent seed (system templates + Brad's contractor account), boot runs
   the migrations. Watch the log for `ScopeWalk API listening`.
4. First check: visit the Render-provided `*.onrender.com` URL → you should see
   the ScopeWalk login screen.

> **Note on the Resend from-address.** The blueprint sends login mail from
> `login@cleanconstructionllc.com`. Resend can send *to* any address, so mail
> reaches Brad's `cleanconstructionllc.19@gmail.com` fine — but the *from*
> domain must be verified in Resend (it already is, for the marketing site).
> When `hello@cleanconstructionllc.com` (Google Workspace) is ready, nothing
> here needs to change; only `SEED_CONTRACTOR_EMAIL` would if Brad's *login*
> address changes.

## 2. Custom domain + DNS

1. Render service → **Settings → Custom Domains** → add
   `scopewalk.cleanconstructionllc.com`. Render shows a target hostname.
2. Your DNS is managed at **Vercel** (the marketing site). Vercel dashboard →
   the `cleanconstructionllc.com` project → **Domains** → add a **CNAME**:
   - Name: `scopewalk`
   - Value: the `*.onrender.com` target Render gave you
3. Wait for DNS to propagate and Render to issue the TLS cert (usually minutes).
   Confirm `https://scopewalk.cleanconstructionllc.com` loads the login screen.

   This subdomain is independent of Resend's domain verification (MX/DKIM on the
   root domain) — adding it changes nothing about email.

## 3. Log in as Brad

1. Go to the site → enter `cleanconstructionllc.19@gmail.com`.
2. Brad receives the sign-in email (from `login@cleanconstructionllc.com`),
   taps the link → lands signed in. The session cookie lasts 90 days.
3. If nothing arrives: check the Render log for `[auth] Resend send failed` and
   the Resend dashboard's Emails log.

## 4. Add the nav link on the Clean Construction site

In the `cleanconstruction` repo's [index.html](index.html), add one entry to
the desktop nav and one to the mobile menu:

```html
<!-- inside <ul class="nav-links"> -->
<li><a href="https://scopewalk.cleanconstructionllc.com" target="_blank" rel="noopener">ScopeWalk</a></li>

<!-- next to the other .mob-link entries -->
<a href="https://scopewalk.cleanconstructionllc.com" target="_blank" rel="noopener" class="mob-link">ScopeWalk</a>
```

`target="_blank"` because it's an internal tool, not a marketing page. Commit,
push — Vercel auto-deploys.

---

## Notes

- **Single origin by design.** The server serves the PWA, `/api/*`, and
  `/p/:token` from the same host — no CORS, session cookie works, PWA offline
  intact. Set `SERVE_STATIC=false` only to run the API standalone.
- **Database.** Turso is the source of truth; Render's local file is an
  embedded replica that re-syncs on every boot, so Render's ephemeral disk is
  fine — no persistent disk needed.
- **Secrets** live only in the Render dashboard and your local `.env`, never in
  git. `render.yaml` contains no secrets.
- **The main app is auth-gated** (magic link → session). The only public
  surface is `/p/:token` customer proposals (unguessable token), which is
  intended. Safe to link from a public nav.
