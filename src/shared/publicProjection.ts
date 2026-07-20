import type { SimulationResult } from '../../logic';

export const PUBLIC_PROJECTION_VERSION = 1;
export const PUBLIC_PROJECTION_PAST_DAYS = 7;
export const PUBLIC_PROJECTION_FUTURE_DAYS = 30;
export const PUBLIC_PROJECTION_MAX_POINTS = 1_200;

const HOUR_MS = 3_600_000;

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
    generatedAt: number;
    mode: 'transfem';
    unit: 'pg/ml';
    series: PublicProjectionPoint[];
}

const round = (value: number, digits: number): number => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
};

function evenlySample(
    points: PublicProjectionPoint[],
    maxPoints: number,
): PublicProjectionPoint[] {
    if (points.length <= maxPoints) return points;

    const sampled: PublicProjectionPoint[] = [];
    let previousIndex = -1;
    for (let index = 0; index < maxPoints; index++) {
        const sourceIndex = Math.round(index * (points.length - 1) / (maxPoints - 1));
        if (sourceIndex === previousIndex) continue;
        sampled.push(points[sourceIndex]);
        previousIndex = sourceIndex;
    }
    return sampled;
}

export function buildStoredPublicProjection(
    simulation: SimulationResult | null,
    calibrationFn: (timeH: number) => number,
    generatedAt = Date.now(),
): StoredPublicProjection {
    const snapshot: StoredPublicProjection = {
        version: PUBLIC_PROJECTION_VERSION,
        generatedAt,
        mode: 'transfem',
        unit: 'pg/ml',
        series: [],
    };
    if (!simulation?.timeH.length || !Number.isFinite(generatedAt)) return snapshot;

    const nowH = generatedAt / HOUR_MS;
    const startH = nowH - PUBLIC_PROJECTION_PAST_DAYS * 24;
    const endH = nowH + PUBLIC_PROJECTION_FUTURE_DAYS * 24;
    const points: PublicProjectionPoint[] = [];

    for (let index = 0; index < simulation.timeH.length; index++) {
        const hour = simulation.timeH[index];
        if (!Number.isFinite(hour) || hour < startH || hour > endH) continue;
        const value = simulation.concPGmL_E2[index] * calibrationFn(hour);
        if (!Number.isFinite(value) || value < 0) continue;
        points.push({
            t: Math.round(hour * HOUR_MS),
            v: round(value, 2),
        });
    }

    snapshot.series = evenlySample(points, PUBLIC_PROJECTION_MAX_POINTS);
    return snapshot;
}
