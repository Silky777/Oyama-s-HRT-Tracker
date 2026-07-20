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

export async function loadState(): Promise<ServerState> {
    const res = await fetch('/api/state', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
    });
    if (!res.ok) throw new Error(`loadState failed: ${res.status}`);
    return (await res.json()) as ServerState;
}

export async function saveState(data: any, baseUpdatedAt?: number): Promise<{ ok: boolean; updated_at: number }> {
    const res = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, ...(baseUpdatedAt === undefined ? {} : { baseUpdatedAt }) }),
    });
    if (res.status === 409) {
        const current = (await res.json()) as ServerState;
        throw new StateConflictError(current);
    }
    if (!res.ok) throw new Error(`saveState failed: ${res.status}`);
    return (await res.json()) as { ok: boolean; updated_at: number };
}
