// Server-side state: the single source of truth for this single-user app.
// The editor host (hrt.silky.moe) is protected by Cloudflare Access, so these
// requests carry the Access session automatically — there is no in-app auth.

export interface ServerState {
    data: any | null;
    updated_at: number;
}

export class StateConflictError extends Error {
    constructor(public readonly current: ServerState) {
        super('Server state changed since it was loaded');
        this.name = 'StateConflictError';
    }
}

export class AccessSessionExpiredError extends Error {
    constructor() {
        super('Cloudflare Access session expired');
        this.name = 'AccessSessionExpiredError';
    }
}

const ACCESS_CHECK_PATH = '/__access_check';

const assertAccessSession = (response: Response): void => {
    let responseHost = '';
    try { responseHost = new URL(response.url).hostname; } catch { /* use status only */ }
    const redirectedToAccess = response.redirected && responseHost.endsWith('.cloudflareaccess.com');
    if (response.status === 401 || redirectedToAccess) throw new AccessSessionExpiredError();
};

/**
 * Leave the service-worker navigation cache and make a real request through
 * Cloudflare Access. After authentication, the Worker's SPA fallback serves
 * the editor at this path and the app cleans the checkpoint out of the URL.
 */
export function forceAccessReauthentication(): void {
    if (typeof window === 'undefined') return;
    const checkpoint = new URL(ACCESS_CHECK_PATH, window.location.origin);
    checkpoint.searchParams.set('from', 'pwa');
    window.location.replace(checkpoint.toString());
}

export function clearAccessReauthenticationCheckpoint(): void {
    if (typeof window === 'undefined' || window.location.pathname !== ACCESS_CHECK_PATH) return;
    window.history.replaceState(window.history.state, '', '/');
}

export async function loadState(): Promise<ServerState> {
    const res = await fetch('/api/state', {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            // Cloudflare Access returns 401 for an expired SPA/AJAX session
            // instead of redirecting this background request to an HTML login.
            'X-Requested-With': 'XMLHttpRequest',
        },
        cache: 'no-store',
    });
    assertAccessSession(res);
    if (!res.ok) throw new Error(`loadState failed: ${res.status}`);
    return (await res.json()) as ServerState;
}

export async function saveState(data: any, baseUpdatedAt?: number): Promise<{ ok: boolean; updated_at: number }> {
    const res = await fetch('/api/state', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ data, ...(baseUpdatedAt === undefined ? {} : { baseUpdatedAt }) }),
    });
    assertAccessSession(res);
    if (res.status === 409) {
        const current = (await res.json()) as ServerState;
        throw new StateConflictError(current);
    }
    if (!res.ok) throw new Error(`saveState failed: ${res.status}`);
    return (await res.json()) as { ok: boolean; updated_at: number };
}
