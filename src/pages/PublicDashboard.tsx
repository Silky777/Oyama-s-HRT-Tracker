import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import AnimatedNumber from '../components/AnimatedNumber';

// Public, read-only dashboard for e.silky.moe. It shows only the current
// estimated level and the concentration curve — the server computes these from
// the stored doses and never sends the raw dose log or lab values here.

interface PublicPayload {
    generatedAt: number;
    mode: 'transfem' | 'transmasc';
    unit: 'pg/ml' | 'ng/dl';
    now: number | null;
    series: { t: number; v: number }[];
    updatedAt: number;
}

const HOUR = 3600000;

// --- Chart helpers (trimmed from ResultChart) --------------------------------

const niceStep = (raw: number): number => {
    if (!(raw > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return nice * mag;
};

const buildYDomain = (min: number, max: number): [number, number] => {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return [0, 1];
    if (max === min) max = max + (max * 0.15 || 1);
    const pad = (max - min) * 0.12;
    const step = niceStep((max - min + 2 * pad) / 4);
    const lo = Math.max(0, Math.floor((min - pad) / step) * step);
    let hi = Math.ceil((max + pad) / step) * step;
    if (hi <= lo) hi = lo + step;
    return [lo, hi];
};

const ticksFor = ([lo, hi]: [number, number]): number[] => {
    const step = niceStep((hi - lo) / 4);
    const out: number[] = [];
    for (let v = lo; v <= hi + step * 0.5; v += step) out.push(Math.round(v / step) * step);
    return out;
};

const fmtAxis = (v: number) => (v >= 100 || v % 1 === 0 ? String(Math.round(v)) : v < 1 ? v.toFixed(2) : v.toFixed(1));

const monotonePath = (xs: number[], ys: number[]): string => {
    const n = xs.length;
    if (n === 0) return '';
    if (n === 1) return `M${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
    const d: number[] = [];
    for (let i = 0; i < n - 1; i++) {
        const h = xs[i + 1] - xs[i];
        d.push(h !== 0 ? (ys[i + 1] - ys[i]) / h : 0);
    }
    const m: number[] = new Array(n);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
        m[i] = (d[i - 1] === 0 || d[i] === 0 || (d[i - 1] < 0) !== (d[i] < 0)) ? 0 : (d[i - 1] + d[i]) / 2;
    }
    for (let i = 0; i < n - 1; i++) {
        if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
        const a = m[i] / d[i];
        const b = m[i + 1] / d[i];
        const s = a * a + b * b;
        if (s > 9) { const tt = 3 / Math.sqrt(s); m[i] *= tt; m[i + 1] *= tt; }
    }
    let out = `M${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
        const dx = (xs[i + 1] - xs[i]) / 3;
        out += `C${(xs[i] + dx).toFixed(1)} ${(ys[i] + m[i] * dx).toFixed(1)} ${(xs[i + 1] - dx).toFixed(1)} ${(ys[i + 1] - m[i + 1] * dx).toFixed(1)} ${xs[i + 1].toFixed(1)} ${ys[i + 1].toFixed(1)}`;
    }
    return out;
};

const useElementSize = (el: HTMLElement | null) => {
    const [size, setSize] = useState({ width: 0, height: 0 });
    useLayoutEffect(() => {
        if (!el) return;
        const measure = () => {
            const r = el.getBoundingClientRect();
            setSize(prev => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
        };
        measure();
        window.addEventListener('resize', measure);
        let ro: ResizeObserver | undefined;
        if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(el); }
        return () => { window.removeEventListener('resize', measure); ro?.disconnect(); };
    }, [el]);
    return size;
};

// --- Theme -------------------------------------------------------------------

const useSystemDark = () => {
    const [dark, setDark] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);
    useEffect(() => {
        const root = document.documentElement;
        root.classList.remove('light', 'dark');
        root.classList.add(dark ? 'dark' : 'light');
    }, [dark]);
    return dark;
};

// --- Chart -------------------------------------------------------------------

const Chart: React.FC<{ payload: PublicPayload; dark: boolean }> = ({ payload, dark }) => {
    const [plotEl, setPlotEl] = useState<HTMLDivElement | null>(null);
    const { width, height } = useElementSize(plotEl);
    const { series } = payload;

    const c = dark
        ? { primary: '#D8927C', grid: '#2E2C28', axis: '#7A776F', faint: '#5C5953', dot: '#1C1B18', area: '#D8927C' }
        : { primary: '#CC785C', grid: '#E7E4DD', axis: '#A8A59E', faint: '#C2BDB3', dot: '#FAF9F7', area: '#CC785C' };

    const t0 = series.length ? series[0].t : 0;
    const t1 = series.length ? series[series.length - 1].t : 1;
    const now = payload.generatedAt;

    const yDomain = useMemo<[number, number]>(() => {
        let mx = -Infinity;
        for (const p of series) if (p.v > mx) mx = p.v;
        return buildYDomain(0, mx);
    }, [series]);

    const mL = 34, mR = 12, mT = 12, mB = 24;
    const plotW = Math.max(0, width - mL - mR);
    const plotH = Math.max(0, height - mT - mB);

    const X = (time: number) => mL + (t1 === t0 ? 0 : ((time - t0) / (t1 - t0)) * plotW);
    const Y = (v: number) => mT + plotH - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * plotH;

    const linePath = useMemo(() => {
        if (!series.length) return '';
        return monotonePath(series.map(p => X(p.t)), series.map(p => Y(p.v)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [series, width, height, yDomain, t0, t1]);

    const areaPath = useMemo(() => {
        if (!linePath || !series.length) return '';
        const base = (mT + plotH).toFixed(1);
        return `${linePath}L${X(series[series.length - 1].t).toFixed(1)} ${base}L${X(series[0].t).toFixed(1)} ${base}Z`;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [linePath, series, width, height]);

    const xTicks = useMemo(() => {
        if (plotW <= 0 || !series.length) return [];
        const count = Math.max(2, Math.min(6, Math.floor(plotW / 90)));
        const seen = new Set<string>();
        const out: { x: number; label: string }[] = [];
        for (let i = 0; i <= count; i++) {
            const time = t0 + ((t1 - t0) * i) / count;
            const label = new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            if (seen.has(label)) continue;
            seen.add(label);
            out.push({ x: X(time), label });
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [t0, t1, plotW, series.length]);

    const nowY = payload.now != null ? Y(payload.now) : null;

    return (
        <div ref={setPlotEl} className="relative h-72 sm:h-96 w-full select-none">
            {width > 0 && series.length > 0 && (
                <svg width={width} height={height} className="block">
                    {/* Y grid + labels */}
                    {ticksFor(yDomain).map((v, i) => {
                        const y = Y(v);
                        if (y < mT - 0.5 || y > mT + plotH + 0.5) return null;
                        return (
                            <g key={`y-${i}`}>
                                <line x1={mL} y1={y} x2={mL + plotW} y2={y} stroke={c.grid} strokeWidth={1} />
                                <text x={mL - 8} y={y + 3} textAnchor="end" fontSize={10} fill={c.axis}>{fmtAxis(v)}</text>
                            </g>
                        );
                    })}

                    {/* X labels */}
                    {xTicks.map((tk, i) => (
                        <text key={`x-${i}`} x={tk.x} y={mT + plotH + 16} textAnchor="middle" fontSize={10} fill={c.axis}>{tk.label}</text>
                    ))}

                    {/* Area + line */}
                    <path d={areaPath} fill={c.area} opacity={0.08} />
                    <path d={linePath} fill="none" stroke={c.primary} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />

                    {/* Now marker */}
                    {now >= t0 && now <= t1 && (
                        <line x1={X(now)} y1={mT} x2={X(now)} y2={mT + plotH} stroke={c.primary} strokeWidth={1} strokeDasharray="3 4" opacity={0.5} />
                    )}
                    {nowY != null && now >= t0 && now <= t1 && (
                        <circle cx={X(now)} cy={nowY} r={4} fill={c.primary} stroke={c.dot} strokeWidth={2} />
                    )}
                </svg>
            )}
        </div>
    );
};

// --- Page --------------------------------------------------------------------

const relTime = (ms: number): string => {
    const diff = Date.now() - ms;
    const min = Math.round(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr} hr${hr === 1 ? '' : 's'} ago`;
    const d = Math.round(hr / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
};

const PublicDashboard: React.FC = () => {
    const dark = useSystemDark();
    const [payload, setPayload] = useState<PublicPayload | null>(null);
    const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
    const [, forceTick] = useState(0);

    const fetchPayload = useRef(async () => {
        try {
            const res = await fetch('/api/public', { cache: 'no-store' });
            if (!res.ok) throw new Error(String(res.status));
            const data = (await res.json()) as PublicPayload;
            setPayload(data);
            setStatus('ok');
        } catch {
            setStatus(prev => (prev === 'ok' ? 'ok' : 'error'));
        }
    });

    useEffect(() => {
        fetchPayload.current();
        const poll = setInterval(() => fetchPayload.current(), 60000);
        const onFocus = () => fetchPayload.current();
        window.addEventListener('focus', onFocus);
        // Re-render every 30s so the "updated N min ago" label stays fresh.
        const clock = setInterval(() => forceTick(x => x + 1), 30000);
        return () => { clearInterval(poll); clearInterval(clock); window.removeEventListener('focus', onFocus); };
    }, []);

    const isTransmasc = payload?.mode === 'transmasc';
    const title = isTransmasc ? 'Testosterone' : 'Estradiol';
    const unitLabel = payload?.unit === 'ng/dl' ? 'ng/dL' : 'pg/mL';
    const value = payload?.now ?? null;

    useEffect(() => {
        document.title = `${title} Dashboard`;
    }, [title]);

    return (
        <div className="min-h-[100dvh] w-full bg-[var(--color-m3-surface)] dark:bg-[var(--color-m3-dark-surface)] text-[var(--color-m3-on-surface)] dark:text-[var(--color-m3-dark-on-surface)] flex flex-col items-center px-5 py-10">
            <div className="w-full max-w-2xl">
                <header className="mb-8">
                    <h1 className="text-sm font-medium tracking-wide text-[var(--color-m3-on-surface-variant)] dark:text-[var(--color-m3-dark-on-surface-variant)] uppercase">
                        Current {title}
                    </h1>
                </header>

                {status === 'error' && !payload && (
                    <p className="text-sm text-[var(--color-m3-on-surface-variant)] dark:text-[var(--color-m3-dark-on-surface-variant)]">
                        Unable to load levels right now.
                    </p>
                )}

                {payload && (
                    <>
                        <div className="mb-8">
                            {value != null ? (
                                <div className="flex items-baseline gap-2">
                                    <span className="text-6xl sm:text-7xl font-semibold tabular-nums tracking-tight">
                                        <AnimatedNumber value={value} decimals={isTransmasc ? 0 : 1} />
                                    </span>
                                    <span className="text-xl text-[var(--color-m3-on-surface-variant)] dark:text-[var(--color-m3-dark-on-surface-variant)]">{unitLabel}</span>
                                </div>
                            ) : (
                                <div className="text-4xl font-semibold text-[var(--color-m3-on-surface-variant)] dark:text-[var(--color-m3-dark-on-surface-variant)]">
                                    No data yet
                                </div>
                            )}
                        </div>

                        <div className="rounded-2xl border border-[var(--color-m3-outline-variant)] dark:border-[var(--color-m3-dark-outline-variant)] p-4 sm:p-5 bg-[var(--color-m3-surface-bright)] dark:bg-[var(--color-m3-dark-surface-container)]">
                            <Chart payload={payload} dark={dark} />
                        </div>

                        <footer className="mt-6 text-xs text-[var(--color-m3-on-surface-variant)] dark:text-[var(--color-m3-dark-on-surface-variant)]">
                            Estimated from a pharmacokinetic model · refreshed {relTime(payload.generatedAt)}
                        </footer>
                    </>
                )}

                {status === 'loading' && !payload && (
                    <div className="h-40 flex items-center text-sm text-[var(--color-m3-on-surface-variant)] dark:text-[var(--color-m3-dark-on-surface-variant)]">
                        Loading…
                    </div>
                )}
            </div>
        </div>
    );
};

export default PublicDashboard;
