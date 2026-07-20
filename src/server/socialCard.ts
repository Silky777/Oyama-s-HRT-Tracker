export interface SocialCardPayload {
    generatedAt: number;
    mode: 'transfem' | 'transmasc';
    unit: 'pg/ml' | 'ng/dl';
    now: number | null;
    series: { t: number; v: number }[];
    updatedAt: number;
}

// 600x315 is the standard 1.91:1 social-card aspect ratio at a resolution that
// remains sharp in chat clients while staying comfortably inside the Workers
// Free CPU budget for on-demand rendering.
export const SOCIAL_CARD_WIDTH = 600;
export const SOCIAL_CARD_HEIGHT = 315;

// An indexed palette keeps the generated PNG small and makes rendering cheap
// enough to do inside a Worker without a browser, an Images binding, or a large
// WASM dependency.
const PALETTE: readonly (readonly [number, number, number])[] = [
    [19, 18, 16],    // background
    [31, 29, 26],    // chart surface
    [58, 54, 49],    // grid
    [143, 136, 125], // axis text
    [216, 146, 124], // accent
    [244, 241, 235], // primary text
    [190, 183, 172], // secondary text
    [48, 37, 33],    // area under curve
    [250, 249, 247], // marker centre
] as const;

const COLOR = {
    background: 0,
    surface: 1,
    grid: 2,
    axis: 3,
    accent: 4,
    text: 5,
    muted: 6,
    area: 7,
    marker: 8,
} as const;

// A tiny built-in bitmap font avoids fetching a font (and avoids making the
// social image route an SSRF surface). At 1200x630 it produces crisp, readable
// labels in Discord's image proxy.
const GLYPHS: Record<string, readonly string[]> = {
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    'C': ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    'G': ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
    'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    'I': ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    'J': ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
    'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    'W': ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
    'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
    '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
    '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
    ':': ['00000', '00110', '00110', '00000', '00110', '00110', '00000'],
    '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
    '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
};

class IndexedBitmap {
    readonly pixels = new Uint8Array(SOCIAL_CARD_WIDTH * SOCIAL_CARD_HEIGHT);

    setPixel(x: number, y: number, color: number): void {
        if (x < 0 || y < 0 || x >= SOCIAL_CARD_WIDTH || y >= SOCIAL_CARD_HEIGHT) return;
        this.pixels[y * SOCIAL_CARD_WIDTH + x] = color;
    }

    fillRect(x: number, y: number, width: number, height: number, color: number): void {
        const left = Math.max(0, Math.floor(x));
        const top = Math.max(0, Math.floor(y));
        const right = Math.min(SOCIAL_CARD_WIDTH, Math.ceil(x + width));
        const bottom = Math.min(SOCIAL_CARD_HEIGHT, Math.ceil(y + height));
        for (let row = top; row < bottom; row++) {
            this.pixels.fill(color, row * SOCIAL_CARD_WIDTH + left, row * SOCIAL_CARD_WIDTH + right);
        }
    }

    fillColumn(x: number, y: number, height: number, color: number): void {
        const column = Math.round(x);
        const top = Math.max(0, Math.floor(y));
        const bottom = Math.min(SOCIAL_CARD_HEIGHT, Math.ceil(y + height));
        if (column < 0 || column >= SOCIAL_CARD_WIDTH) return;
        for (let row = top; row < bottom; row++) this.pixels[row * SOCIAL_CARD_WIDTH + column] = color;
    }

    fillRoundedRect(x: number, y: number, width: number, height: number, radius: number, color: number): void {
        const r = Math.max(0, Math.min(radius, Math.floor(Math.min(width, height) / 2)));
        this.fillRect(x + r, y, width - r * 2, height, color);
        this.fillRect(x, y + r, width, height - r * 2, color);
        for (let dy = 0; dy < r; dy++) {
            const fromCentre = r - dy - 0.5;
            const inset = Math.ceil(r - Math.sqrt(Math.max(0, r * r - fromCentre * fromCentre)));
            this.fillRect(x + inset, y + dy, width - inset * 2, 1, color);
            this.fillRect(x + inset, y + height - dy - 1, width - inset * 2, 1, color);
        }
    }

    fillCircle(cx: number, cy: number, radius: number, color: number): void {
        const r = Math.max(0, Math.floor(radius));
        for (let dy = -r; dy <= r; dy++) {
            const halfWidth = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
            this.fillRect(cx - halfWidth, cy + dy, halfWidth * 2 + 1, 1, color);
        }
    }

    line(x0: number, y0: number, x1: number, y1: number, color: number, thickness = 1): void {
        if (![x0, y0, x1, y1].every(Number.isFinite)) return;
        let x = Math.round(x0);
        let y = Math.round(y0);
        const endX = Math.round(x1);
        const endY = Math.round(y1);
        const dx = Math.abs(endX - x);
        const sx = x < endX ? 1 : -1;
        const dy = -Math.abs(endY - y);
        const sy = y < endY ? 1 : -1;
        let error = dx + dy;
        const radius = Math.max(0, Math.floor((thickness - 1) / 2));

        while (true) {
            if (radius > 0) this.fillCircle(x, y, radius, color);
            else this.setPixel(x, y, color);
            if (x === endX && y === endY) break;
            const doubled = error * 2;
            if (doubled >= dy) { error += dy; x += sx; }
            if (doubled <= dx) { error += dx; y += sy; }
        }
    }

    textWidth(value: string, scale: number): number {
        return Math.max(0, value.length * 6 * scale - scale);
    }

    text(value: string, x: number, y: number, scale: number, color: number): void {
        let cursor = Math.round(x);
        for (const character of value.toUpperCase()) {
            const glyph = GLYPHS[character] ?? GLYPHS['?'];
            for (let row = 0; row < glyph.length; row++) {
                for (let column = 0; column < glyph[row].length; column++) {
                    if (glyph[row][column] === '1') {
                        this.fillRect(cursor + column * scale, y + row * scale, scale, scale, color);
                    }
                }
            }
            cursor += 6 * scale;
        }
    }
}

const finitePoints = (payload: SocialCardPayload): { t: number; v: number }[] => payload.series
    .filter(point => (
        Number.isFinite(point.t) &&
        Math.abs(point.t) <= 8_640_000_000_000_000 &&
        Number.isFinite(point.v) &&
        point.v >= 0
    ))
    .map(point => ({ t: point.t, v: Math.min(point.v, 1_000_000) }))
    .sort((a, b) => a.t - b.t);

const niceStep = (raw: number): number => {
    if (!(raw > 0)) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const normalized = raw / magnitude;
    const nice = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
    return nice * magnitude;
};

const yMaximum = (points: { v: number }[]): number => {
    const maximum = points.reduce((value, point) => Math.max(value, point.v), 0);
    if (!(maximum > 0)) return 1;
    const step = niceStep(maximum / 4);
    return Math.max(step, Math.ceil(maximum / step) * step);
};

const formatAxis = (value: number): string => {
    if (value >= 100 || Number.isInteger(value)) return String(Math.round(value));
    if (value < 1) return value.toFixed(2);
    return value.toFixed(1);
};

const relativeSpanLabel = (milliseconds: number, future: boolean): string => {
    const days = Math.max(1, Math.round(Math.abs(milliseconds) / 86_400_000));
    const duration = `${days} DAY${days === 1 ? '' : 'S'}`;
    return future ? `IN ${duration}` : `${duration} AGO`;
};

const drawChart = (bitmap: IndexedBitmap, payload: SocialCardPayload): void => {
    const points = finitePoints(payload);
    const cardX = 24;
    const cardY = 130;
    const cardWidth = 552;
    const cardHeight = 150;
    bitmap.fillRoundedRect(cardX, cardY, cardWidth, cardHeight, 12, COLOR.surface);

    if (points.length < 2) {
        const message = 'NO SYNCED CURVE YET';
        bitmap.text(message, (SOCIAL_CARD_WIDTH - bitmap.textWidth(message, 3)) / 2, 192, 3, COLOR.muted);
        return;
    }

    const left = 61;
    const right = 560;
    const top = 142;
    const bottom = 258;
    const width = right - left;
    const height = bottom - top;
    const startTime = points[0].t;
    const endTime = points[points.length - 1].t;
    const maxY = yMaximum(points);
    const xFor = (time: number): number => left + ((time - startTime) / Math.max(1, endTime - startTime)) * width;
    const yFor = (value: number): number => bottom - (Math.max(0, Math.min(maxY, value)) / maxY) * height;

    // Fill beneath the curve before drawing grid and line details.
    for (let index = 0; index < points.length - 1; index++) {
        const fromX = Math.round(xFor(points[index].t));
        const toX = Math.round(xFor(points[index + 1].t));
        const fromY = yFor(points[index].v);
        const toY = yFor(points[index + 1].v);
        const span = Math.max(1, toX - fromX);
        for (let x = fromX; x <= toX; x++) {
            const ratio = (x - fromX) / span;
            const y = Math.round(fromY + (toY - fromY) * ratio);
            bitmap.fillColumn(x, y, bottom - y + 1, COLOR.area);
        }
    }

    for (let tick = 0; tick <= 4; tick++) {
        const value = (maxY * tick) / 4;
        const y = Math.round(yFor(value));
        bitmap.fillRect(left, y, width, 1, COLOR.grid);
        const label = formatAxis(value);
        bitmap.text(label, left - bitmap.textWidth(label, 1) - 7, y - 3, 1, COLOR.axis);
    }

    const nowX = xFor(payload.generatedAt);
    if (nowX >= left && nowX <= right) {
        for (let y = top; y <= bottom; y += 6) bitmap.fillRect(Math.round(nowX), y, 1, 3, COLOR.accent);
    }

    for (let index = 0; index < points.length - 1; index++) {
        bitmap.line(
            xFor(points[index].t),
            yFor(points[index].v),
            xFor(points[index + 1].t),
            yFor(points[index + 1].v),
            COLOR.accent,
            3,
        );
    }

    if (payload.now != null && Number.isFinite(payload.now) && nowX >= left && nowX <= right) {
        const nowY = yFor(payload.now);
        bitmap.fillCircle(Math.round(nowX), Math.round(nowY), 4, COLOR.accent);
        bitmap.fillCircle(Math.round(nowX), Math.round(nowY), 2, COLOR.marker);
    }

    const past = relativeSpanLabel(payload.generatedAt - startTime, false);
    const current = 'NOW';
    const future = relativeSpanLabel(endTime - payload.generatedAt, true);
    const pastWidth = bitmap.textWidth(past, 1);
    const currentWidth = bitmap.textWidth(current, 1);
    const futureWidth = bitmap.textWidth(future, 1);
    const currentX = Math.max(left, Math.min(right - currentWidth, nowX - currentWidth / 2));
    const futureX = right - futureWidth;
    if (currentX - (left + pastWidth) >= 9) bitmap.text(past, left, 266, 1, COLOR.axis);
    bitmap.text(current, currentX, 266, 1, COLOR.axis);
    if (futureX - (currentX + currentWidth) >= 9) bitmap.text(future, futureX, 266, 1, COLOR.axis);
};

const drawSocialCard = (payload: SocialCardPayload): IndexedBitmap => {
    const bitmap = new IndexedBitmap();
    bitmap.pixels.fill(COLOR.background);

    const isTransmasc = payload.mode === 'transmasc';
    const hormone = isTransmasc ? 'TESTOSTERONE' : 'ESTRADIOL';
    const unit = payload.unit === 'ng/dl' ? 'NG/DL' : 'PG/ML';
    const eyebrow = `CURRENT ${hormone}`;
    bitmap.text(eyebrow, 28, 24, 2, COLOR.muted);

    const site = 'E.SILKY.MOE';
    bitmap.text(site, SOCIAL_CARD_WIDTH - bitmap.textWidth(site, 2) - 28, 26, 2, COLOR.axis);

    if (payload.now != null && Number.isFinite(payload.now)) {
        const value = isTransmasc ? String(Math.round(payload.now)) : payload.now.toFixed(1);
        bitmap.text(value, 28, 52, 6, COLOR.text);
        bitmap.text(unit, 28 + bitmap.textWidth(value, 6) + 14, 76, 2, COLOR.muted);
    } else {
        bitmap.text('NO SYNCED DATA YET', 28, 58, 4, COLOR.text);
    }

    bitmap.text('MODELED CONCENTRATION CURVE', 28, 109, 2, COLOR.muted);
    drawChart(bitmap, payload);

    bitmap.text('MODELED ESTIMATE - NOT A LAB RESULT', 28, 296, 2, COLOR.axis);
    return bitmap;
};

const writeUint32 = (target: Uint8Array, offset: number, value: number): void => {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
};

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        table[index] = value >>> 0;
    }
    return table;
})();

const crc32 = (data: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (name: string, data = new Uint8Array()): Uint8Array => {
    const nameBytes = new TextEncoder().encode(name);
    const output = new Uint8Array(data.length + 12);
    writeUint32(output, 0, data.length);
    output.set(nameBytes, 4);
    output.set(data, 8);
    writeUint32(output, data.length + 8, crc32(output.subarray(4, data.length + 8)));
    return output;
};

const concatenate = (parts: Uint8Array[]): Uint8Array => {
    const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
};

const encodePng = async (pixels: Uint8Array): Promise<Uint8Array> => {
    const rowLength = SOCIAL_CARD_WIDTH + 1;
    const scanlines = new Uint8Array(rowLength * SOCIAL_CARD_HEIGHT);
    for (let y = 0; y < SOCIAL_CARD_HEIGHT; y++) {
        const rowOffset = y * rowLength;
        scanlines[rowOffset] = 0; // PNG filter type: None
        scanlines.set(
            pixels.subarray(y * SOCIAL_CARD_WIDTH, (y + 1) * SOCIAL_CARD_WIDTH),
            rowOffset + 1,
        );
    }

    const stream = new Blob([scanlines.buffer]).stream().pipeThrough(new CompressionStream('deflate'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());

    const header = new Uint8Array(13);
    writeUint32(header, 0, SOCIAL_CARD_WIDTH);
    writeUint32(header, 4, SOCIAL_CARD_HEIGHT);
    header[8] = 8; // bit depth
    header[9] = 3; // indexed colour
    header[10] = 0; // compression
    header[11] = 0; // filtering
    header[12] = 0; // no interlace

    const palette = new Uint8Array(PALETTE.length * 3);
    PALETTE.forEach((color, index) => palette.set(color, index * 3));

    return concatenate([
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('PLTE', palette),
        chunk('IDAT', compressed),
        chunk('IEND'),
    ]);
};

export const renderSocialCardPng = async (payload: SocialCardPayload): Promise<Uint8Array> => {
    const bitmap = drawSocialCard(payload);
    return encodePng(bitmap.pixels);
};
