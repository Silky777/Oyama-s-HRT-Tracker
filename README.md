# HRT Tracker

A single-user HRT dose tracker and pharmacokinetic level simulator. The editor is
served at `hrt.silky.moe` behind Cloudflare Access; the read-only public dashboard
is served at `e.silky.moe`.

## How it works

- D1 is the source of truth for doses, labs, templates, quick-dose presets, body
  weight, calibration settings, and PK overrides.
- The browser keeps a write-through `localStorage` cache for fast startup and
  offline edits. Failed saves retry when connectivity returns.
- There is no in-app account, password, session, 2FA, passkey, admin, avatar, or
  multi-user stack. Cloudflare Access protects the editor host.
- The public API computes the estimated hormone curve inside the Worker. It
  returns only the current modeled level and curve points, never doses or labs.
- To stay within edge CPU limits, public EKF/MIPD projections retain their
  amplitude calibration but omit the private editor's personal-clearance grid.
  The authenticated editor continues to use the full calibration fit.
- The public HTML includes server-rendered Open Graph metadata, and
  `/api/embed.png` renders the same safe projection as a 600x315 graph card for
  Discord and other link previews.
- English is the default language. The existing language picker remains.

The Worker stores one canonical JSON document in `app_state` and keeps the 20
most recent prior documents in `state_history` for recovery.

## Local development

The repository's primary package manager is Bun 1.2.15, matching Cloudflare's
Workers Builds image. `bun.lock` is committed and should remain synchronized.

```bash
bun install --frozen-lockfile
bun run wrangler:migrate:local
bun run build
bun run wrangler:dev
```

Open `http://localhost:8787` for the editor. Use
`http://localhost:8787/?public` to preview the public dashboard.

For frontend-only development, `bun run dev` starts Vite on port 3000 and proxies
`/api` to a separately running Worker on port 8787.

`package-lock.json` is also retained because the Docker and desktop GitHub
Actions builds intentionally use `npm ci`.

## Cloudflare deployment

`wrangler.toml` is configured for both custom hosts and has `workers_dev = false`.
Before deploying:

1. Confirm that the D1 database ID and the `silky.moe` zone in `wrangler.toml`
   are correct.
2. Apply the non-destructive migration:

   ```bash
   bun run wrangler:migrate:remote
   ```

3. In Cloudflare Zero Trust, create or keep an Access application for
   `hrt.silky.moe` and allow only your email/identity. Do not place
   `e.silky.moe` behind Access.
4. In the connected Worker's **Settings > Build**, use:

   - Build command: `bun run build`
   - Deploy command: `bunx wrangler deploy`
   - Build variable: `BUN_VERSION=1.2.15`

   For a manual deployment, run:

   ```bash
   bun run build
   bunx wrangler deploy
   ```

### Cloudflare Access verification

Access at the edge is sufficient when `workers_dev` remains disabled. For
defense in depth, set these Worker variables in `wrangler.toml`:

```toml
ACCESS_TEAM_DOMAIN = "your-team-name"
ACCESS_AUD = "your-access-application-audience-tag"
```

When configured, the Worker verifies `Cf-Access-Jwt-Assertion` for both reads and
writes to `/api/state`.

For a passcode-like flow, enable Cloudflare Access's One-time PIN identity
provider and keep the email allow policy. The PIN is issued and checked by
Cloudflare, so no secret is shipped in this app. A reusable shared static
passcode is intentionally not implemented because that would recreate an
in-app authentication system.

## First server seed and existing data

When `app_state` is empty, a device with meaningful cached data seeds D1 from
that cache. A brand-new empty device deliberately does not create an empty row,
so it cannot wipe the older browser that still holds your history. Open the
device containing your newest data first. After D1 has a state row, every device
hydrates from the server instead of replacing it.

The migration does not delete the old multi-user tables. If important data only
exists in an old cloud backup, export or inspect it before removing the old
deployment. Do not blindly copy an encrypted legacy `content.data` value into
`app_state`; import the decrypted tracker export through the editor instead.

## Social previews

Sharing `https://e.silky.moe/` produces a snapshot of the modeled current level
and curve at crawl time. Discord and other services cache unfurls, so an already
posted preview does not update live. Use **Copy share link** on the public
dashboard to copy a query-versioned URL when a guaranteed fresh re-scrape is
needed.

## Docker

The container runs the Worker and a persistent local D1 database without any
JWT or admin secrets:

```bash
cp .env.docker.example .env
docker compose up -d
```

Data is stored in `./data`. Open `http://localhost:8787`; add `?public` to preview
the public dashboard.

## Pharmacokinetic model

The pharmacokinetic algorithms and parameters are derived from
[HRT-Recorder-PKcomponent-Test](https://github.com/LaoZhong-Mihari/HRT-Recorder-PKcomponent-Test),
including the multi-compartment and route-specific absorption models. Estimated
levels are informational and are not medical advice or a substitute for lab
testing and clinician guidance.

## License

MIT. See [LICENSE](./LICENSE).
