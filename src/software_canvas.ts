/**
 * Lightweight, zero-dependency 2D canvas rasterizer in pure TypeScript.
 *
 * Implements `BoardCanvasContext` so match replay states can be rendered in headless
 * Node.js environments (CLI, server API) identically to the browser canvas.
 */

import type { BoardCanvasContext } from "./board_render.js";

export interface AffineMatrix {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

/** Parses color string into [r, g, b, a] in 0..255 range. */
export function parseRgba(str: string): [number, number, number, number] {
    const trimmed = (str ?? "").trim();
    if (trimmed.startsWith("#")) {
        let hex = trimmed.slice(1);
        if (hex.length === 3) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        if (hex.length === 6) {
            return [
                parseInt(hex.slice(0, 2), 16) || 0,
                parseInt(hex.slice(2, 4), 16) || 0,
                parseInt(hex.slice(4, 6), 16) || 0,
                255,
            ];
        }
        if (hex.length === 8) {
            return [
                parseInt(hex.slice(0, 2), 16) || 0,
                parseInt(hex.slice(2, 4), 16) || 0,
                parseInt(hex.slice(4, 6), 16) || 0,
                parseInt(hex.slice(6, 8), 16) || 0,
            ];
        }
    }
    const m = /^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i.exec(trimmed);
    if (m !== null) {
        return [
            Number(m[1]) & 255,
            Number(m[2]) & 255,
            Number(m[3]) & 255,
            m[4] !== undefined ? Math.max(0, Math.min(255, Math.round(Number(m[4]) * 255))) : 255,
        ];
    }
    return [255, 255, 255, 255];
}

interface PathItem {
    type: "moveTo" | "lineTo" | "arc";
    x: number;
    y: number;
    r?: number;
    sa?: number;
    ea?: number;
}

export class SoftwareCanvas implements BoardCanvasContext {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;

    fillStyle: string = "#000000";
    strokeStyle: string = "#000000";
    lineWidth: number = 1;

    private matrixStack: AffineMatrix[] = [];
    private curMatrix: AffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    private path: PathItem[] = [];

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
    }

    save(): void {
        this.matrixStack.push({ ...this.curMatrix });
    }

    restore(): void {
        const prev = this.matrixStack.pop();
        if (prev !== undefined) {
            this.curMatrix = prev;
        }
    }

    translate(x: number, y: number): void {
        const m = this.curMatrix;
        this.curMatrix = {
            a: m.a,
            b: m.b,
            c: m.c,
            d: m.d,
            e: m.a * x + m.c * y + m.e,
            f: m.b * x + m.d * y + m.f,
        };
    }

    rotate(angle: number): void {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const m = this.curMatrix;
        this.curMatrix = {
            a: m.a * cos + m.c * sin,
            b: m.b * cos + m.d * sin,
            c: -m.a * sin + m.c * cos,
            d: -m.b * sin + m.d * cos,
            e: m.e,
            f: m.f,
        };
    }

    transformPoint(x: number, y: number): [number, number] {
        const m = this.curMatrix;
        return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
    }

    setPixel(x: number, y: number, r: number, g: number, b: number, a: number): void {
        const px = Math.round(x);
        const py = Math.round(y);
        if (px < 0 || px >= this.width || py < 0 || py >= this.height || a <= 0) return;
        const idx = (py * this.width + px) * 4;
        if (a >= 255) {
            this.data[idx] = r;
            this.data[idx + 1] = g;
            this.data[idx + 2] = b;
            this.data[idx + 3] = 255;
        } else {
            const alpha = a / 255;
            const inv = 1 - alpha;
            this.data[idx] = Math.round(r * alpha + this.data[idx] * inv);
            this.data[idx + 1] = Math.round(g * alpha + this.data[idx + 1] * inv);
            this.data[idx + 2] = Math.round(b * alpha + this.data[idx + 2] * inv);
            this.data[idx + 3] = 255;
        }
    }

    clearRect(x: number, y: number, w: number, h: number): void {
        const x0 = Math.max(0, Math.floor(x));
        const y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(this.width, Math.ceil(x + w));
        const y1 = Math.min(this.height, Math.ceil(y + h));
        for (let py = y0; py < y1; py++) {
            const start = (py * this.width + x0) * 4;
            const end = (py * this.width + x1) * 4;
            this.data.fill(0, start, end);
        }
    }

    fillRect(x: number, y: number, w: number, h: number): void {
        const [r, g, b, a] = parseRgba(this.fillStyle);
        if (a <= 0) return;

        const isIdentity =
            this.curMatrix.b === 0 &&
            this.curMatrix.c === 0 &&
            this.curMatrix.a === 1 &&
            this.curMatrix.d === 1;

        if (isIdentity) {
            const tx = x + this.curMatrix.e;
            const ty = y + this.curMatrix.f;
            const x0 = Math.max(0, Math.floor(tx));
            const y0 = Math.max(0, Math.floor(ty));
            const x1 = Math.min(this.width, Math.ceil(tx + w));
            const y1 = Math.min(this.height, Math.ceil(ty + h));
            for (let py = y0; py < y1; py++) {
                for (let px = x0; px < x1; px++) {
                    this.setPixel(px, py, r, g, b, a);
                }
            }
        } else {
            const p0 = this.transformPoint(x, y);
            const p1 = this.transformPoint(x + w, y);
            const p2 = this.transformPoint(x + w, y + h);
            const p3 = this.transformPoint(x, y + h);
            this.fillConvexPolygon([p0, p1, p2, p3], r, g, b, a);
        }
    }

    strokeRect(x: number, y: number, w: number, h: number): void {
        const p0 = this.transformPoint(x, y);
        const p1 = this.transformPoint(x + w, y);
        const p2 = this.transformPoint(x + w, y + h);
        const p3 = this.transformPoint(x, y + h);
        const [r, g, b, a] = parseRgba(this.strokeStyle);
        const lw = Math.max(1, this.lineWidth);
        this.drawLine(p0[0], p0[1], p1[0], p1[1], r, g, b, a, lw);
        this.drawLine(p1[0], p1[1], p2[0], p2[1], r, g, b, a, lw);
        this.drawLine(p2[0], p2[1], p3[0], p3[1], r, g, b, a, lw);
        this.drawLine(p3[0], p3[1], p0[0], p0[1], r, g, b, a, lw);
    }

    beginPath(): void {
        this.path = [];
    }

    moveTo(x: number, y: number): void {
        const [tx, ty] = this.transformPoint(x, y);
        this.path.push({ type: "moveTo", x: tx, y: ty });
    }

    lineTo(x: number, y: number): void {
        const [tx, ty] = this.transformPoint(x, y);
        this.path.push({ type: "lineTo", x: tx, y: ty });
    }

    arc(cx: number, cy: number, r: number, sa: number, ea: number): void {
        const [tx, ty] = this.transformPoint(cx, cy);
        this.path.push({ type: "arc", x: tx, y: ty, r, sa, ea });
    }

    fill(): void {
        const [r, g, b, a] = parseRgba(this.fillStyle);
        if (a <= 0) return;
        for (const item of this.path) {
            if (item.type === "arc") {
                const cx = item.x;
                const cy = item.y;
                const radius = item.r ?? 0;
                const x0 = Math.max(0, Math.floor(cx - radius));
                const x1 = Math.min(this.width - 1, Math.ceil(cx + radius));
                const y0 = Math.max(0, Math.floor(cy - radius));
                const y1 = Math.min(this.height - 1, Math.ceil(cy + radius));
                const r2 = radius * radius;
                for (let py = y0; py <= y1; py++) {
                    const dy = py - cy;
                    const dy2 = dy * dy;
                    if (dy2 > r2) continue;
                    const maxDx = Math.sqrt(r2 - dy2);
                    const lx = Math.max(x0, Math.floor(cx - maxDx));
                    const rx = Math.min(x1, Math.ceil(cx + maxDx));
                    for (let px = lx; px <= rx; px++) {
                        this.setPixel(px, py, r, g, b, a);
                    }
                }
            }
        }
    }

    stroke(): void {
        const [r, g, b, a] = parseRgba(this.strokeStyle);
        if (a <= 0) return;
        const lw = Math.max(1, this.lineWidth);
        let curX = 0;
        let curY = 0;
        for (const item of this.path) {
            if (item.type === "moveTo") {
                curX = item.x;
                curY = item.y;
            } else if (item.type === "lineTo") {
                this.drawLine(curX, curY, item.x, item.y, r, g, b, a, lw);
                curX = item.x;
                curY = item.y;
            } else if (item.type === "arc") {
                const cx = item.x;
                const cy = item.y;
                const radius = item.r ?? 0;
                const sa = item.sa ?? 0;
                const ea = item.ea ?? Math.PI * 2;
                const steps = Math.max(12, Math.ceil(Math.abs(ea - sa) * radius * 1.5));
                const dAngle = (ea - sa) / steps;
                let prevX = cx + radius * Math.cos(sa);
                let prevY = cy + radius * Math.sin(sa);
                for (let s = 1; s <= steps; s++) {
                    const angle = sa + s * dAngle;
                    const nx = cx + radius * Math.cos(angle);
                    const ny = cy + radius * Math.sin(angle);
                    this.drawLine(prevX, prevY, nx, ny, r, g, b, a, lw);
                    prevX = nx;
                    prevY = ny;
                }
            }
        }
    }

    private drawLine(
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        r: number,
        g: number,
        b: number,
        a: number,
        lw: number,
    ): void {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist === 0) {
            this.setPixel(x0, y0, r, g, b, a);
            return;
        }
        const steps = Math.ceil(dist * 2);
        const radius = lw / 2;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const px = x0 + dx * t;
            const py = y0 + dy * t;
            if (lw <= 1.2) {
                this.setPixel(px, py, r, g, b, a);
            } else {
                const rCeil = Math.ceil(radius);
                for (let oy = -rCeil; oy <= rCeil; oy++) {
                    for (let ox = -rCeil; ox <= rCeil; ox++) {
                        if (ox * ox + oy * oy <= radius * radius) {
                            this.setPixel(px + ox, py + oy, r, g, b, a);
                        }
                    }
                }
            }
        }
    }

    private fillConvexPolygon(
        points: [number, number][],
        r: number,
        g: number,
        b: number,
        a: number,
    ): void {
        let minY = Infinity;
        let maxY = -Infinity;
        for (const p of points) {
            if (p[1] < minY) minY = p[1];
            if (p[1] > maxY) maxY = p[1];
        }
        minY = Math.max(0, Math.floor(minY));
        maxY = Math.min(this.height - 1, Math.ceil(maxY));

        for (let y = minY; y <= maxY; y++) {
            const py = y + 0.5;
            const nodes: number[] = [];
            for (let i = 0; i < points.length; i++) {
                const j = (i + 1) % points.length;
                const y1 = points[i][1];
                const y2 = points[j][1];
                if ((y1 < py && y2 >= py) || (y2 < py && y1 >= py)) {
                    nodes.push(points[i][0] + ((py - y1) / (y2 - y1)) * (points[j][0] - points[i][0]));
                }
            }
            nodes.sort((n1, n2) => n1 - n2);
            for (let i = 0; i < nodes.length; i += 2) {
                const xStart = Math.max(0, Math.floor(nodes[i]));
                const xEnd = Math.min(this.width - 1, Math.ceil(nodes[i + 1]));
                for (let x = xStart; x <= xEnd; x++) {
                    this.setPixel(x, y, r, g, b, a);
                }
            }
        }
    }
}
