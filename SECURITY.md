# Security model

## Trust boundary

This is a single-user application. Cloudflare Access must protect
`hrt.silky.moe`; the app contains no login or account system of its own.
`workers_dev = false` prevents the default Worker hostname from bypassing the
custom-host Access policy.

`e.silky.moe` is intentionally public. The Worker returns 404 for `/api/state`
on that host. `/api/public` contains only a modeled current level, unit, mode,
timestamps, and curve points. Raw doses, labs, templates, settings, and D1
history are not included.

## Defense in depth

Setting both `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` makes the Worker verify the
Cloudflare Access JWT on every `/api/state` request. If either value is absent,
the Worker trusts Access at the edge. Keep `workers_dev` disabled in that mode.

The state API:

- accepts only the canonical two-mode state shape;
- limits serialized state to 1.5 MB;
- uses parameterized D1 statements;
- responds with `Cache-Control: no-store`;
- supports an optional `baseUpdatedAt` optimistic-concurrency check;
- writes the previous value to a rolling 20-entry history in the same D1 batch.

The deployed responses include a same-origin Content Security Policy, framing
protection, a no-referrer policy, and restrictive browser permissions. The API
does not enable cross-origin reads.

## Cloudflare Access setup

Use an email/identity allow policy for the editor host. Cloudflare One-time PIN
can provide a PIN-based sign-in while keeping verification at Cloudflare. Never
put a reusable passcode in frontend code, a public Worker variable, or the D1
state document.

The public host must be excluded from the Access application so visitors can
load the dashboard. Confirm after deployment that:

- unauthenticated `hrt.silky.moe` requests are intercepted by Access;
- `e.silky.moe/api/state` returns 404;
- `e.silky.moe/api/public` contains no dose or lab fields;
- the `*.workers.dev` route is unavailable.

## Data recovery

The old auth tables are not dropped by the migration. The active state is in
`app_state`; the previous 20 versions are in `state_history`. Treat D1 exports as
sensitive because those tables contain raw treatment records.

## Reporting

Report security issues privately to the repository owner. Do not include real
treatment data, Cloudflare Access assertions, or D1 exports in a public issue.
