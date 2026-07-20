-- Single-user server-backed state.
-- Non-destructive: creates the new tables without dropping the legacy
-- multi-user tables (users/content/sessions/passkeys/...). The Worker also
-- self-ensures these tables at runtime (see ensureStateTables in worker.ts),
-- so running this migration is optional but recommended.

-- The one authoritative copy of the app's data (the buildExportPayload blob:
-- { modes: { transfem, transmasc }, weight, pkParams, calibration* }).
CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Rolling snapshots of prior states (auto-pruned to the latest 20 on each save)
-- so a bad edit can be recovered.
CREATE TABLE IF NOT EXISTS state_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_state_history_created_at ON state_history(created_at);
