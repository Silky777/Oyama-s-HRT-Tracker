import type { SimulationResult } from '../../logic';

export const PUBLIC_PROJECTION_VERSION = 2;
export const PUBLIC_PROJECTION_PAST_DAYS = 7;
export const PUBLIC_PROJECTION_FUTURE_DAYS = 45;
export const PUBLIC_PROJECTION_VISIBLE_FUTURE_DAYS = 7;
export const PUBLIC_PROJECTION_REFRESH_LEAD_DAYS = 2;
export const PUBLIC_PROJECTION_MAX_POINTS = 1_200;
export const PUBLIC_PROJECTION_CLOCK_SKEW_MS = 5 * 60_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface PublicProjectionPoint {
    t: number;
    v: number;
}

/**
 * Safe, pre-sampled data saved by the authenticated editor for public display.
 * It deliberately contains no dose events, lab records, or user settings.
 */
export interface StoredPublicProjection {
    version: typeof PUBLIC_PROJECTION_VERSION;
    sourceHash: string;
    generatedAt: number;
    validUntil: number;
    mode: 'transfem';
    unit: 'pg/ml';
    series: PublicProjectionPoint[];
}

const round = (value: number, digits: number): number => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
};

/** Shape-preserving Largest-Triangle-Three-Buckets downsampling. */
function downsampleLttb(
    points: PublicProjectionPoint[],
    maxPoints: number,
): PublicProjectionPoint[] {
    if (points.length <= maxPoints) return points;
    if (maxPoints < 3) return [points[0], points[points.length - 1]].slice(0, maxPoints);

    const sampled: PublicProjectionPoint[] = [points[0]];
    const every = (points.length - 2) / (maxPoints - 2);
    let anchorIndex = 0;

    for (let bucket = 0; bucket < maxPoints - 2; bucket++) {
        const averageStart = Math.min(points.length, Math.floor((bucket + 1) * every) + 1);
        const averageEnd = Math.min(points.length, Math.floor((bucket + 2) * every) + 1);
        const averageCount = Math.max(1, averageEnd - averageStart);
        let averageT = 0;
        let averageV = 0;
        for (let index = averageStart; index < averageEnd; index++) {
            averageT += points[index].t;
            averageV += points[index].v;
        }
        if (averageStart >= points.length) {
            averageT = points[points.length - 1].t;
            averageV = points[points.length - 1].v;
        } else {
            averageT /= averageCount;
            averageV /= averageCount;
        }

        const rangeStart = Math.floor(bucket * every) + 1;
        const rangeEnd = Math.min(points.length - 1, Math.floor((bucket + 1) * every) + 1);
        const anchor = points[anchorIndex];
        let selectedIndex = rangeStart;
        let maxArea = -1;
        for (let index = rangeStart; index < rangeEnd; index++) {
            const candidate = points[index];
            const area = Math.abs(
                (anchor.t - averageT) * (candidate.v - anchor.v) -
                (anchor.t - candidate.t) * (averageV - anchor.v)
            );
            if (area > maxArea) {
                maxArea = area;
                selectedIndex = index;
            }
        }
        sampled.push(points[selectedIndex]);
        anchorIndex = selectedIndex;
    }

    sampled.push(points[points.length - 1]);
    return sampled;
}

function valueAt(
    simulation: SimulationResult,
    calibrationFn: (timeH: number) => number,
    timeH: number,
): number | null {
    const times = simulation.timeH;
    if (!times.length || timeH < times[0] || timeH > times[times.length - 1]) return null;
    let low = 0;
    let high = times.length - 1;
    while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (times[middle] === timeH) {
            const exact = simulation.concPGmL_E2[middle] * calibrationFn(timeH);
            return Number.isFinite(exact) && exact >= 0 ? exact : null;
        }
        if (times[middle] < timeH) low = middle;
        else high = middle;
    }
    const span = times[high] - times[low];
    if (span <= 0) return null;
    const ratio = (timeH - times[low]) / span;
    const raw = simulation.concPGmL_E2[low] +
        (simulation.concPGmL_E2[high] - simulation.concPGmL_E2[low]) * ratio;
    const calibrated = raw * calibrationFn(timeH);
    return Number.isFinite(calibrated) && calibrated >= 0 ? calibrated : null;
}

export function hashPublicProjectionSource(serializedSource: string): string {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < serializedSource.length; index++) {
        const code = serializedSource.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x85ebca6b);
    }
    return `p${PUBLIC_PROJECTION_VERSION}-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function isStoredPublicProjectionReusable(
    projection: StoredPublicProjection | null,
    sourceHash: string,
    now = Date.now(),
    requireSeries = false,
): projection is StoredPublicProjection {
    if (
        !projection ||
        projection.version !== PUBLIC_PROJECTION_VERSION ||
        projection.sourceHash !== sourceHash ||
        projection.mode !== 'transfem' ||
        projection.unit !== 'pg/ml' ||
        !Number.isSafeInteger(projection.generatedAt) ||
        projection.generatedAt < 0 || projection.generatedAt > now + PUBLIC_PROJECTION_CLOCK_SKEW_MS ||
        !Number.isSafeInteger(projection.validUntil) ||
        projection.validUntil < now + PUBLIC_PROJECTION_REFRESH_LEAD_DAYS * DAY_MS ||
        projection.validUntil < projection.generatedAt ||
        projection.validUntil > projection.generatedAt + PUBLIC_PROJECTION_FUTURE_DAYS * DAY_MS + 60_000 ||
        !Array.isArray(projection.series) ||
        projection.series.length > PUBLIC_PROJECTION_MAX_POINTS ||
        (requireSeries && projection.series.length === 0)
    ) return false;

    let previousTime = -Infinity;
    for (const point of projection.series) {
        if (
            !point || !Number.isSafeInteger(point.t) || point.t <= previousTime ||
            !Number.isFinite(point.v) || point.v < 0 || point.v > 1_000_000
        ) return false;
        previousTime = point.t;
    }
    if (projection.series.length) {
        if (
            projection.series[0].t > now - PUBLIC_PROJECTION_PAST_DAYS * DAY_MS ||
            projection.series[projection.series.length - 1].t < now + PUBLIC_PROJECTION_VISIBLE_FUTURE_DAYS * DAY_MS
        ) return false;
    }
    return true;
}

export function buildStoredPublicProjection(
    simulation: SimulationResult | null,
    calibrationFn: (timeH: number) => number,
    sourceHash: string,
    generatedAt = Date.now(),
): StoredPublicProjection {
    const snapshot: StoredPublicProjection = {
        version: PUBLIC_PROJECTION_VERSION,
        sourceHash,
        generatedAt,
        validUntil: generatedAt +
            (PUBLIC_PROJECTION_FUTURE_DAYS - PUBLIC_PROJECTION_VISIBLE_FUTURE_DAYS) * DAY_MS,
        mode: 'transfem',
        unit: 'pg/ml',
        series: [],
    };
    if (!simulation?.timeH.length || !Number.isFinite(generatedAt)) return snapshot;

    const nowH = generatedAt / HOUR_MS;
    const startH = nowH - PUBLIC_PROJECTION_PAST_DAYS * 24;
    const endH = nowH + PUBLIC_PROJECTION_FUTURE_DAYS * 24;
    const pointsByTime = new Map<number, PublicProjectionPoint>();

    const addPoint = (hour: number, value: number | null) => {
        if (value === null || !Number.isFinite(value) || value < 0) return;
        const point = { t: Math.round(hour * HOUR_MS), v: round(value, 2) };
        pointsByTime.set(point.t, point);
    };

    // Exact boundaries keep moving-window interpolation valid; the exact now
    // point also stabilizes the headline value after shape-preserving sampling.
    const startValue = valueAt(simulation, calibrationFn, startH);
    // A new tracker may have less than seven days of history. Before its first
    // simulated dose the concentration is exactly zero, so preserve the full
    // public window with an explicit zero boundary instead of producing a
    // snapshot that both the browser and Worker must reject as incomplete.
    addPoint(startH, startValue ?? (startH < simulation.timeH[0] ? 0 : null));
    addPoint(nowH, valueAt(simulation, calibrationFn, nowH));
    addPoint(endH, valueAt(simulation, calibrationFn, endH));

    for (let index = 0; index < simulation.timeH.length; index++) {
        const hour = simulation.timeH[index];
        if (!Number.isFinite(hour) || hour < startH || hour > endH) continue;
        const value = simulation.concPGmL_E2[index] * calibrationFn(hour);
        addPoint(hour, value);
    }

    const points = [...pointsByTime.values()].sort((left, right) => left.t - right.t);
    const sampled = downsampleLttb(points, Math.max(3, PUBLIC_PROJECTION_MAX_POINTS - 1));
    const exactNow = pointsByTime.get(Math.round(generatedAt));
    if (exactNow) sampled.push(exactNow);
    snapshot.series = [...new Map(sampled.map(point => [point.t, point])).values()]
        .sort((left, right) => left.t - right.t)
        .slice(0, PUBLIC_PROJECTION_MAX_POINTS);
    if (snapshot.series.length) {
        snapshot.validUntil = snapshot.series[snapshot.series.length - 1].t -
            PUBLIC_PROJECTION_VISIBLE_FUTURE_DAYS * DAY_MS;
    }
    return snapshot;
}
