export const APP_VERSION = "Stable 1.4.0";

export type AppTheme = 'light' | 'dark' | 'system' | 'mono';

// Hostname of the public, read-only dashboard. When the app is served from this
// host it renders PublicDashboard instead of the editor. Append `?public` on
// localhost to preview the public view. Keep in sync with PUBLIC_HOST in
// wrangler.toml / worker.ts.
export const PUBLIC_HOST = 'e.silky.moe';
