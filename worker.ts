import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  runSimulation,
  computeCalibration,
  applyPKOverrides,
  interpolateConcentration_E2,
  interpolateConcentration_T,
  normalizeCalibrationMethod,
  DoseEvent,
  LabResult,
  PKCustomParams,
} from './logic';

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
const PUBLIC_MAX_POINTS = 600;
const MAX_STATE_BYTES = 1_500_000;
const HOUR_MS = 3_600_000;

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

async function buildPublicPayload(env: Env): Promise<PublicPayload> {
  await ensureStateTables(env);
  const isTransmasc = PUBLIC_DISPLAY_MODE === 'transmasc';
  const unit = isTransmasc ? 'ng/dl' : 'pg/ml';
  const nowMs = Date.now();

  const row = await env.DB.prepare('SELECT data, updated_at FROM app_state WHERE id = 1')
    .first<StateRow>();
  const empty: PublicPayload = {
    generatedAt: nowMs,
    mode: PUBLIC_DISPLAY_MODE,
    unit,
    now: null,
    series: [],
    updatedAt: row?.updated_at ?? 0,
  };
  if (!row?.data) return empty;

  let state: any;
  try { state = JSON.parse(row.data); } catch { return empty; }

  const modeState = state?.modes?.[PUBLIC_DISPLAY_MODE] ?? {};
  const events: DoseEvent[] = Array.isArray(modeState.events) ? modeState.events : [];
  const labResults: LabResult[] = Array.isArray(modeState.labResults) ? modeState.labResults : [];
  const weight = typeof state?.weight === 'number' && state.weight > 0 ? state.weight : 70;
  const pkParams: PKCustomParams | null = state?.pkParams && typeof state.pkParams === 'object'
    ? state.pkParams
    : null;

  applyPKOverrides(pkParams);
  const simulation = runSimulation(events, weight, PUBLIC_WINDOW_DAYS_FUTURE * 24);
  if (!simulation?.timeH.length) return empty;

  let calibrationFn: (hour: number) => number = () => 1;
  if (!isTransmasc) {
    try {
      const method = normalizeCalibrationMethod(state?.calibrationMethod);
      const historyMode = state?.calibrationHistoryMode === 'forward' ? 'forward' : 'retrospective';
      const calibration = computeCalibration(simulation, events, weight, labResults, method, historyMode);
      if (calibration?.factorFn) calibrationFn = calibration.factorFn;
    } catch {
      // A calibration failure should not take down the public dashboard.
    }
  }

  const nowH = nowMs / HOUR_MS;
  const startH = nowH - PUBLIC_WINDOW_DAYS_PAST * 24;
  const endH = nowH + PUBLIC_WINDOW_DAYS_FUTURE * 24;
  const points: { t: number; v: number }[] = [];

  for (let index = 0; index < simulation.timeH.length; index++) {
    const hour = simulation.timeH[index];
    if (hour < startH || hour > endH) continue;
    const concentration = isTransmasc
      ? simulation.concNGdL_T[index]
      : simulation.concPGmL_E2[index] * calibrationFn(hour);
    if (!Number.isFinite(concentration)) continue;
    points.push({ t: Math.round(hour * HOUR_MS), v: round(concentration, 2) });
  }

  const stride = Math.max(1, Math.ceil(points.length / PUBLIC_MAX_POINTS));
  const series = stride === 1 ? points : points.filter((_, index) => index % stride === 0);
  const currentRaw = isTransmasc
    ? interpolateConcentration_T(simulation, nowH)
    : (() => {
        const value = interpolateConcentration_E2(simulation, nowH);
        return value == null ? null : value * calibrationFn(nowH);
      })();
  const now = currentRaw != null && Number.isFinite(currentRaw) ? round(currentRaw, 1) : null;

  return {
    generatedAt: nowMs,
    mode: PUBLIC_DISPLAY_MODE,
    unit,
    now,
    series,
    updatedAt: row.updated_at,
  };
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
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const publicHost = (env.PUBLIC_HOST || DEFAULT_PUBLIC_HOST).toLowerCase();
    const appHost = (env.APP_HOST || DEFAULT_APP_HOST).toLowerCase();
    const localDev = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    const onPublicHost = host === publicHost;
    const onAppHost = host === appHost || localDev;

    if (!onPublicHost && !onAppHost) return text('Not Found', 404);

    if (!url.pathname.startsWith('/api/')) {
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    }

    try {
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
