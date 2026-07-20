import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  renderSocialCardPng,
  SOCIAL_CARD_HEIGHT,
  SOCIAL_CARD_WIDTH,
} from './src/server/socialCard';
import {
  PUBLIC_PROJECTION_CLOCK_SKEW_MS,
  PUBLIC_PROJECTION_MAX_POINTS,
  PUBLIC_PROJECTION_VERSION,
  StoredPublicProjection,
} from './src/shared/publicProjection';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PUBLIC_HOST?: string;
  APP_HOST?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

const DEFAULT_PUBLIC_HOST = 'e.silky.moe';
const DEFAULT_APP_HOST = 'hrt.silky.moe';
const PUBLIC_DISPLAY_MODE: 'transfem' | 'transmasc' = 'transfem';
const PUBLIC_WINDOW_DAYS_PAST = 7;
const PUBLIC_WINDOW_DAYS_FUTURE = 7;
const MAX_STATE_BYTES = 1_500_000;
const HOUR_MS = 3_600_000;
const SOCIAL_CARD_BUCKET_MS = 5 * 60_000;
const SOCIAL_CARD_RENDER_VERSION = 1;

function withSecurityHeaders(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('X-XSS-Protection', '0');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  result.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none';",
  );
  return result;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return withSecurityHeaders(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  }));
}

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return withSecurityHeaders(new Response(body, { status, headers }));
}

let stateTablesEnsured = false;
async function ensureStateTables(env: Env): Promise<void> {
  if (stateTablesEnsured) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS state_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
  ]);
  stateTablesEnsured = true;
}

let accessJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let accessJwksIssuer = '';

async function accessAllowed(request: Request, env: Env): Promise<boolean> {
  const team = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;

  // If these are not configured, Cloudflare Access remains the security
  // boundary. workers_dev is disabled, so there is no public Worker URL bypass.
  if (!team || !audience) return true;

  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion) return false;

  try {
    const issuer = `https://${team}.cloudflareaccess.com`;
    if (!accessJwks || accessJwksIssuer !== issuer) {
      accessJwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      accessJwksIssuer = issuer;
    }
    await jwtVerify(assertion, accessJwks, { issuer, audience });
    return true;
  } catch {
    return false;
  }
}

const round = (value: number, decimalPlaces: number): number => {
  const factor = Math.pow(10, decimalPlaces);
  return Math.round(value * factor) / factor;
};

interface PublicPayload {
  generatedAt: number;
  mode: 'transfem' | 'transmasc';
  unit: 'pg/ml' | 'ng/dl';
  now: number | null;
  series: { t: number; v: number }[];
  updatedAt: number;
}

function safeStoredPublicProjection(value: unknown, nowMs: number): StoredPublicProjection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const projection = value as Record<string, unknown>;
  const projectionKeys = new Set(['version', 'sourceHash', 'generatedAt', 'validUntil', 'mode', 'unit', 'series']);
  if (
    Object.keys(projection).some(key => !projectionKeys.has(key)) ||
    projection.version !== PUBLIC_PROJECTION_VERSION ||
    typeof projection.sourceHash !== 'string' ||
      !new RegExp(`^p${PUBLIC_PROJECTION_VERSION}-[0-9a-f]{16}$`).test(projection.sourceHash) ||
    projection.mode !== 'transfem' ||
    projection.unit !== 'pg/ml' ||
    typeof projection.generatedAt !== 'number' || !Number.isSafeInteger(projection.generatedAt) ||
    projection.generatedAt < 0 || projection.generatedAt > nowMs + PUBLIC_PROJECTION_CLOCK_SKEW_MS ||
    typeof projection.validUntil !== 'number' || !Number.isSafeInteger(projection.validUntil) ||
    projection.validUntil < nowMs || projection.validUntil < projection.generatedAt ||
    projection.validUntil > projection.generatedAt + 60 * 24 * HOUR_MS ||
    !Array.isArray(projection.series) ||
    projection.series.length > PUBLIC_PROJECTION_MAX_POINTS
  ) return null;

  const series: { t: number; v: number }[] = [];
  let previousTime = -Infinity;
  for (const valuePoint of projection.series) {
    if (!valuePoint || typeof valuePoint !== 'object' || Array.isArray(valuePoint)) return null;
    const point = valuePoint as Record<string, unknown>;
    if (
      Object.keys(point).some(key => key !== 't' && key !== 'v') ||
      typeof point.t !== 'number' || !Number.isFinite(point.t) || !Number.isSafeInteger(point.t) ||
      point.t <= previousTime || point.t < 0 || point.t > 8_640_000_000_000_000 ||
      typeof point.v !== 'number' || !Number.isFinite(point.v) || point.v < 0 || point.v > 1_000_000
    ) return null;
    series.push({ t: point.t, v: point.v });
    previousTime = point.t;
  }

  if (series.length) {
    const visiblePastMs = PUBLIC_WINDOW_DAYS_PAST * 24 * HOUR_MS;
    const visibleFutureMs = PUBLIC_WINDOW_DAYS_FUTURE * 24 * HOUR_MS;
    const lastTime = series[series.length - 1].t;
    if (
      series[0].t > nowMs - visiblePastMs + PUBLIC_PROJECTION_CLOCK_SKEW_MS ||
      lastTime < nowMs + visibleFutureMs ||
      projection.validUntil > lastTime - visibleFutureMs + 60_000
    ) return null;
  }

  return {
    version: PUBLIC_PROJECTION_VERSION,
    sourceHash: projection.sourceHash,
    generatedAt: projection.generatedAt,
    validUntil: projection.validUntil,
    mode: 'transfem',
    unit: 'pg/ml',
    series,
  };
}

function interpolateProjection(
  series: { t: number; v: number }[],
  timestamp: number,
): number | null {
  if (!series.length || timestamp < series[0].t || timestamp > series[series.length - 1].t) return null;
  let low = 0;
  let high = series.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (series[middle].t === timestamp) return series[middle].v;
    if (series[middle].t < timestamp) low = middle;
    else high = middle;
  }
  const left = series[low];
  const right = series[high];
  if (left.t === right.t) return left.v;
  const ratio = (timestamp - left.t) / (right.t - left.t);
  return left.v + (right.v - left.v) * ratio;
}

function payloadFromStoredProjection(
  projection: StoredPublicProjection,
  nowMs: number,
): PublicPayload {
  const startMs = nowMs - PUBLIC_WINDOW_DAYS_PAST * 24 * HOUR_MS;
  const endMs = nowMs + PUBLIC_WINDOW_DAYS_FUTURE * 24 * HOUR_MS;
  const seriesByTime = new Map<number, { t: number; v: number }>();
  const startValue = interpolateProjection(projection.series, startMs);
  const endValue = interpolateProjection(projection.series, endMs);
  if (startValue != null) seriesByTime.set(startMs, { t: startMs, v: round(startValue, 2) });
  for (const point of projection.series) {
    if (point.t > startMs && point.t < endMs) seriesByTime.set(point.t, point);
  }
  if (endValue != null) seriesByTime.set(endMs, { t: endMs, v: round(endValue, 2) });
  const series = [...seriesByTime.values()].sort((left, right) => left.t - right.t);
  const current = interpolateProjection(projection.series, nowMs);
  return {
    generatedAt: nowMs,
    mode: 'transfem',
    unit: 'pg/ml',
    now: current == null || !Number.isFinite(current) ? null : round(current, 1),
    series,
    // Version public caches from the snapshot itself; a transmasc-only/raw
    // state save must not churn the public image URL.
    updatedAt: projection.generatedAt,
  };
}

const publicRevisionFor = (updatedAt: number, generatedAt: number): string => (
  `r${SOCIAL_CARD_RENDER_VERSION}-${updatedAt}-${Math.floor(generatedAt / SOCIAL_CARD_BUCKET_MS)}`
);

const publicRevision = (payload: PublicPayload): string => publicRevisionFor(
  payload.updatedAt,
  payload.generatedAt,
);

async function latestPublicProjectionGeneratedAt(env: Env): Promise<number> {
  await ensureStateTables(env);
  const row = await env.DB.prepare(
    `SELECT CASE WHEN json_valid(data)
       THEN CAST(json_extract(data, '$.publicProjection.generatedAt') AS INTEGER)
       ELSE NULL END AS projection_at
     FROM app_state WHERE id = 1`,
  ).first<{ projection_at: number | null }>();
  return typeof row?.projection_at === 'number' && Number.isFinite(row.projection_at)
    ? row.projection_at
    : 0;
}

const publicLabels = (payload: PublicPayload) => {
  const hormone = payload.mode === 'transmasc' ? 'Testosterone' : 'Estradiol';
  const unit = payload.unit === 'ng/dl' ? 'ng/dL' : 'pg/mL';
  const value = payload.now == null
    ? null
    : payload.mode === 'transmasc' ? String(Math.round(payload.now)) : payload.now.toFixed(1);
  const title = value == null
    ? `${hormone} dashboard`
    : `Current ${hormone}: ${value} ${unit}`;
  const description = value == null
    ? `Public ${hormone.toLowerCase()} dashboard. No synced estimate is available yet.`
    : `Current modeled ${hormone.toLowerCase()} level: ${value} ${unit}. View the recent and projected concentration curve.`;
  return { hormone, unit, value, title, description };
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[character] || character));

function publicHtmlResponse(
  assetResponse: Response,
  payload: PublicPayload,
  requestUrl: URL,
): Response {
  const labels = publicLabels(payload);
  const revision = publicRevision(payload);
  const pageUrl = `${requestUrl.origin}/`;
  const imageUrl = `${requestUrl.origin}/api/embed.png?v=${encodeURIComponent(revision)}`;
  const title = escapeHtml(labels.title);
  const description = escapeHtml(labels.description);
  const escapedPageUrl = escapeHtml(pageUrl);
  const escapedImageUrl = escapeHtml(imageUrl);
  const imageAlt = escapeHtml(`${labels.title} with a modeled concentration curve`);
  const metadata = [
    `<meta name="description" content="${description}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="HRT Levels">',
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${escapedPageUrl}">`,
    `<meta property="og:image" content="${escapedImageUrl}">`,
    `<meta property="og:image:secure_url" content="${escapedImageUrl}">`,
    '<meta property="og:image:type" content="image/png">',
    `<meta property="og:image:width" content="${SOCIAL_CARD_WIDTH}">`,
    `<meta property="og:image:height" content="${SOCIAL_CARD_HEIGHT}">`,
    `<meta property="og:image:alt" content="${imageAlt}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${escapedImageUrl}">`,
    `<meta name="twitter:image:alt" content="${imageAlt}">`,
  ].join('');

  const headers = new Headers(assetResponse.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  headers.set('Content-Type', 'text/html; charset=UTF-8');

  const rewritten = new HTMLRewriter()
    .on('title', {
      element(element) { element.setInnerContent(labels.title); },
    })
    .on('head', {
      element(element) { element.append(metadata, { html: true }); },
    })
    .transform(new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    }));

  return withSecurityHeaders(rewritten);
}

const socialCardHeaders = (revision: string): Record<string, string> => ({
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=300, s-maxage=300',
  // Separate colos can render a few seconds apart inside one five-minute
  // revision. A weak validator correctly marks those bytes as equivalent.
  'ETag': `W/"${revision}"`,
});

async function buildPublicPayload(env: Env): Promise<PublicPayload> {
  await ensureStateTables(env);
  const nowMs = Date.now();

  const row = await env.DB.prepare('SELECT data, updated_at FROM app_state WHERE id = 1')
    .first<StateRow>();
  const empty: PublicPayload = {
    generatedAt: nowMs,
    mode: PUBLIC_DISPLAY_MODE,
    unit: 'pg/ml',
    now: null,
    series: [],
    updatedAt: 0,
  };
  if (!row?.data) return empty;

  let state: any;
  try { state = JSON.parse(row.data); } catch { return empty; }

  // Normal public requests are a bounded D1 read plus interpolation. The
  // authenticated editor computed this already-calibrated curve when it saved,
  // so crawlers never need to rerun the pharmacokinetic model at the edge.
  const storedProjection = safeStoredPublicProjection(state?.publicProjection, nowMs);
  if (storedProjection) {
    return payloadFromStoredProjection(storedProjection, nowMs);
  }
  // Missing/legacy/invalid snapshots fail closed. Opening the authenticated
  // editor backfills one through the normal state sync without exposing raw
  // events or spending simulation CPU on an unauthenticated request.
  return empty;
}

type StateRow = { data: string; updated_at: number };

function parseStoredState(row: StateRow | null): unknown | null {
  if (!row?.data) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

function isCanonicalState(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const modes = (value as any).modes;
  if (!modes || typeof modes !== 'object') return false;

  for (const mode of ['transfem', 'transmasc']) {
    const modeState = modes[mode];
    if (!modeState || typeof modeState !== 'object') return false;
    if (
      !Array.isArray(modeState.events) ||
      !Array.isArray(modeState.labResults) ||
      !Array.isArray(modeState.doseTemplates)
    ) return false;
  }
  return true;
}

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const publicHost = (env.PUBLIC_HOST || DEFAULT_PUBLIC_HOST).toLowerCase();
    const appHost = (env.APP_HOST || DEFAULT_APP_HOST).toLowerCase();
    const localDev = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    const onPublicHost = host === publicHost;
    const onAppHost = host === appHost || localDev;

    if (!onPublicHost && !onAppHost) return text('Not Found', 404);

    if (!url.pathname.startsWith('/api/')) {
      let assetRequest = request;
      if ((onPublicHost || localDev) && request.method === 'GET') {
        // The public HTML is dynamic even though its underlying SPA shell is a
        // static asset. Do not let an old asset ETag turn this into a body-less
        // 304 before the current social metadata can be injected.
        const headers = new Headers(request.headers);
        headers.delete('If-None-Match');
        headers.delete('If-Modified-Since');
        assetRequest = new Request(request, { headers });
      }
      const assetResponse = await env.ASSETS.fetch(assetRequest);
      const isHtml = assetResponse.headers.get('Content-Type')?.toLowerCase().includes('text/html');
      if ((!onPublicHost && !localDev) || request.method !== 'GET' || !isHtml) {
        return withSecurityHeaders(assetResponse);
      }

      // Social crawlers do not execute the React app. Put the current public
      // estimate in the initial HTML so Discord and other unfurlers can see it.
      // If D1 is temporarily unavailable, the dashboard itself still loads.
      try {
        const payload = await buildPublicPayload(env);
        return publicHtmlResponse(assetResponse, payload, url);
      } catch (error) {
        console.error('Public metadata error:', error);
        return withSecurityHeaders(assetResponse);
      }
    }

    try {
      if (url.pathname === '/api/embed.png') {
        if (!onPublicHost && !localDev) return text('Not Found', 404);
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return text('Method Not Allowed', 405, { Allow: 'GET, HEAD' });
        }

        let revision = publicRevisionFor(await latestPublicProjectionGeneratedAt(env), Date.now());
        let headers = socialCardHeaders(revision);
        if (request.headers.get('If-None-Match') === headers.ETag) {
          return withSecurityHeaders(new Response(null, { status: 304, headers }));
        }
        if (request.method === 'HEAD') return withSecurityHeaders(new Response(null, { headers }));

        const cacheRequestFor = (value: string): Request => {
          const cacheUrl = new URL(request.url);
          // Ignore arbitrary query parameters when choosing the cache key. Only
          // server-derived state/time can create a rendered image variant.
          cacheUrl.search = `?v=${encodeURIComponent(value)}`;
          return new Request(cacheUrl.toString(), { method: 'GET' });
        };
        const edgeCache = (caches as unknown as { default: Cache }).default;
        let cacheRequest = cacheRequestFor(revision);
        let cached = await edgeCache.match(cacheRequest);
        if (cached) {
          return withSecurityHeaders(cached);
        }

        const payload = await buildPublicPayload(env);
        const renderedRevision = publicRevision(payload);
        if (renderedRevision !== revision) {
          // State or the time bucket changed between the cheap version lookup
          // and the full projection. Re-check the correct cache key before
          // spending CPU on a render.
          revision = renderedRevision;
          headers = socialCardHeaders(revision);
          if (request.headers.get('If-None-Match') === headers.ETag) {
            return withSecurityHeaders(new Response(null, { status: 304, headers }));
          }
          cacheRequest = cacheRequestFor(revision);
          cached = await edgeCache.match(cacheRequest);
          if (cached) return withSecurityHeaders(cached);
        }

        const png = await renderSocialCardPng(payload);
        const response = withSecurityHeaders(new Response(png, { headers }));
        ctx.waitUntil(edgeCache.put(cacheRequest, response.clone()));
        return response;
      }

      if (url.pathname === '/api/public' && request.method === 'GET') {
        const payload = await buildPublicPayload(env);
        return json(payload, 200, {
          'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
        });
      }

      if (url.pathname === '/api/state') {
        // The public host can never read or mutate the raw dose/lab state.
        if (!onAppHost) return text('Not Found', 404);
        if (!(await accessAllowed(request, env))) return text('Forbidden', 403);
        await ensureStateTables(env);

        if (request.method === 'GET') {
          const row = await env.DB.prepare('SELECT data, updated_at FROM app_state WHERE id = 1')
            .first<StateRow>();
          return json(
            { data: parseStoredState(row), updated_at: row?.updated_at ?? 0 },
            200,
            { 'Cache-Control': 'no-store' },
          );
        }

        if (request.method === 'PUT') {
          const declaredLength = Number(request.headers.get('Content-Length') || 0);
          if (declaredLength > MAX_STATE_BYTES) return text('State is too large', 413);

          const rawBody = await request.text();
          if (byteLength(rawBody) > MAX_STATE_BYTES) return text('State is too large', 413);

          let body: any;
          try { body = JSON.parse(rawBody); } catch { return text('Bad JSON', 400); }
          if (!isCanonicalState(body?.data)) return text('Invalid state', 400);

          const serialized = JSON.stringify(body.data);
          if (byteLength(serialized) > MAX_STATE_BYTES) return text('State is too large', 413);

          const baseUpdatedAt = body.baseUpdatedAt;
          if (baseUpdatedAt !== undefined && (!Number.isInteger(baseUpdatedAt) || baseUpdatedAt < 0)) {
            return text('Invalid baseUpdatedAt', 400);
          }

          const current = await env.DB.prepare('SELECT data, updated_at FROM app_state WHERE id = 1')
            .first<StateRow>();
          const currentVersion = current?.updated_at ?? 0;
          if (baseUpdatedAt !== undefined && baseUpdatedAt !== currentVersion) {
            return json(
              { error: 'conflict', data: parseStoredState(current), updated_at: currentVersion },
              409,
              { 'Cache-Control': 'no-store' },
            );
          }

          const now = Math.max(Date.now(), currentVersion + 1);

          if (baseUpdatedAt === 0) {
            const result = await env.DB.prepare(
              'INSERT INTO app_state (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING',
            ).bind(serialized, now).run();
            if (!result.meta.changes) {
              const latest = await env.DB.prepare('SELECT data, updated_at FROM app_state WHERE id = 1')
                .first<StateRow>();
              return json(
                { error: 'conflict', data: parseStoredState(latest), updated_at: latest?.updated_at ?? 0 },
                409,
                { 'Cache-Control': 'no-store' },
              );
            }
          } else if (baseUpdatedAt !== undefined) {
            const results = await env.DB.batch([
              env.DB.prepare(
                'INSERT INTO state_history (data, created_at) SELECT data, ? FROM app_state WHERE id = 1 AND updated_at = ?',
              ).bind(now, baseUpdatedAt),
              env.DB.prepare(
                'UPDATE app_state SET data = ?, updated_at = ? WHERE id = 1 AND updated_at = ?',
              ).bind(serialized, now, baseUpdatedAt),
              env.DB.prepare(
                'DELETE FROM state_history WHERE id NOT IN (SELECT id FROM state_history ORDER BY created_at DESC, id DESC LIMIT 20)',
              ),
            ]);
            if (!results[1].meta.changes) {
              const latest = await env.DB.prepare('SELECT data, updated_at FROM app_state WHERE id = 1')
                .first<StateRow>();
              return json(
                { error: 'conflict', data: parseStoredState(latest), updated_at: latest?.updated_at ?? 0 },
                409,
                { 'Cache-Control': 'no-store' },
              );
            }
          } else {
            // The normal single-user policy is last-write-wins. Every prior
            // state is retained in a rolling history in the same D1 batch.
            await env.DB.batch([
              env.DB.prepare(
                'INSERT INTO state_history (data, created_at) SELECT data, ? FROM app_state WHERE id = 1',
              ).bind(now),
              env.DB.prepare(
                'INSERT INTO app_state (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
              ).bind(serialized, now),
              env.DB.prepare(
                'DELETE FROM state_history WHERE id NOT IN (SELECT id FROM state_history ORDER BY created_at DESC, id DESC LIMIT 20)',
              ),
            ]);
          }

          return json({ ok: true, updated_at: now });
        }

        return text('Method Not Allowed', 405, { Allow: 'GET, PUT' });
      }

      return text('Not Found', 404);
    } catch (error: any) {
      console.error('API Error:', error);
      const isProd = !localDev;
      return text(isProd ? 'Internal Server Error' : (error?.message || 'Internal Server Error'), 500);
    }
  },
};
