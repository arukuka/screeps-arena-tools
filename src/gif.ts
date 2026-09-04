/**
 * Zero-dependency animated GIF encoder and replay GIF generator.
 *
 * Implements GIF89a specification with LZW compression and Netscape 2.0 looping.
 * Pure TypeScript running on Node.js without any external image libraries.
 */

import { drawBoard } from "./board_render.js";
import { FALLBACK_SIDE_COLOR, NEUTRAL } from "./board_render.js";
import { SoftwareCanvas } from "./software_canvas.js";
import { buildTimeline, stateAt } from "./timeline.js";
import type { ReplayDoc } from "./types.js";

export interface GifFrameData {
    lzw: Buffer;
    palette: number[][];
    delay: number;
}

/**
 * GIF89a Animation Encoder.
 */
export class GifEncoder {
    readonly width: number;
    readonly height: number;
    readonly frames: GifFrameData[] = [];

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    /**
     * Add a 256-color indexed frame.
     *
     * @param pixels Pixel indices (0..255), length = width * height
     * @param palette Array of [r, g, b] colors (up to 256 entries)
     * @param delayMs Frame duration in milliseconds (e.g. 100 for 10 fps)
     */
    addFrame(pixels: Uint8Array, palette: number[][], delayMs: number): void {
        const delay = Math.max(2, Math.round(delayMs / 10)); // 1/100ths of a second
        const lzw = this.encodeLzw(pixels);
        this.frames.push({ lzw, palette, delay });
    }

    private encodeLzw(pixels: Uint8Array): Buffer {
        const minCodeSize = 8;
        const clearCode = 1 << minCodeSize; // 256
        const eoiCode = clearCode + 1; // 257

        const out: number[] = [];
        let curBit = 0;
        let curAcc = 0;
        const subBlock: number[] = [];

        const flushSubBlock = (): void => {
            if (subBlock.length > 0) {
                out.push(subBlock.length, ...subBlock);
                subBlock.length = 0;
            }
        };

        const writeBits = (code: number, size: number): void => {
            curAcc |= code << curBit;
            curBit += size;
            while (curBit >= 8) {
                subBlock.push(curAcc & 0xff);
                if (subBlock.length === 255) flushSubBlock();
                curAcc >>= 8;
                curBit -= 8;
            }
        };

        const flushBits = (): void => {
            if (curBit > 0) {
                subBlock.push(curAcc & 0xff);
                if (subBlock.length === 255) flushSubBlock();
                curBit = 0;
                curAcc = 0;
            }
            flushSubBlock();
            out.push(0x00); // Block terminator
        };

        let codeSize = minCodeSize + 1;
        let nextCode = eoiCode + 1;
        const dict = new Map<number, number>();

        const resetDict = (): void => {
            dict.clear();
            codeSize = minCodeSize + 1;
            nextCode = eoiCode + 1;
        };

        writeBits(clearCode, codeSize);

        if (pixels.length > 0) {
            let prefix = pixels[0];
            for (let i = 1; i < pixels.length; i++) {
                const k = pixels[i];
                const key = (prefix << 8) | k;
                const code = dict.get(key);
                if (code !== undefined) {
                    prefix = code;
                } else {
                    writeBits(prefix, codeSize);
                    if (nextCode < 4096) {
                        dict.set(key, nextCode++);
                        if (nextCode > (1 << codeSize) && codeSize < 12) {
                            codeSize++;
                        }
                    } else {
                        writeBits(clearCode, codeSize);
                        resetDict();
                    }
                    prefix = k;
                }
            }
            writeBits(prefix, codeSize);
        }

        writeBits(eoiCode, codeSize);
        flushBits();

        return Buffer.from([minCodeSize, ...out]);
    }

    /**
     * Finish encoding and assemble binary GIF file buffer.
     */
    finish(): Buffer {
        const parts: Buffer[] = [];

        // 1. Header
        parts.push(Buffer.from("GIF89a", "ascii"));

        // 2. Logical Screen Descriptor (7 bytes)
        const lsd = Buffer.alloc(7);
        lsd.writeUInt16LE(this.width, 0);
        lsd.writeUInt16LE(this.height, 2);
        lsd[4] = 0x70; // No global color table, 8 bits/pixel color resolution
        lsd[5] = 0; // Background color index
        lsd[6] = 0; // Pixel aspect ratio
        parts.push(lsd);

        // 3. Netscape 2.0 Application Extension (for infinite loop)
        parts.push(
            Buffer.from([
                0x21,
                0xff,
                0x0b,
                ...Buffer.from("NETSCAPE2.0", "ascii"),
                0x03,
                0x01,
                0x00,
                0x00, // 0 = loop forever
                0x00,
            ]),
        );

        // 4. Frames
        for (const frame of this.frames) {
            // Graphic Control Extension (8 bytes)
            parts.push(
                Buffer.from([
                    0x21,
                    0xf9,
                    0x04,
                    0x08, // Disposal method: 2 (restore to background)
                    frame.delay & 0xff,
                    (frame.delay >> 8) & 0xff,
                    0x00, // Transparent color index
                    0x00, // Block terminator
                ]),
            );

            // Image Descriptor (10 bytes) with Local Color Table flag (0x87 = 256 colors)
            const id = Buffer.alloc(10);
            id[0] = 0x2c;
            id.writeUInt16LE(0, 1); // Left
            id.writeUInt16LE(0, 3); // Top
            id.writeUInt16LE(this.width, 5);
            id.writeUInt16LE(this.height, 7);
            id[9] = 0x87; // Local Color Table present, 256 colors (2^(7+1))
            parts.push(id);

            // Local Color Table (256 * 3 = 768 bytes)
            const lct = Buffer.alloc(256 * 3);
            for (let i = 0; i < 256; i++) {
                const rgb = frame.palette[i] ?? [0, 0, 0];
                lct[i * 3] = rgb[0];
                lct[i * 3 + 1] = rgb[1];
                lct[i * 3 + 2] = rgb[2];
            }
            parts.push(lct);

            // Image Data (LZW compressed stream)
            parts.push(frame.lzw);
        }

        // 5. Trailer (1 byte)
        parts.push(Buffer.from([0x3b]));
        return Buffer.concat(parts);
    }
}

/**
 * Maps RGBA buffer pixels to a 256-color palette.
 */
export function quantizeFrame(rgba: Uint8ClampedArray): {
    palette: number[][];
    indexed: Uint8Array;
} {
    const totalPixels = rgba.length / 4;
    const indexed = new Uint8Array(totalPixels);
    const colorMap = new Map<number, number>();
    const palette: number[][] = [];

    for (let i = 0; i < totalPixels; i++) {
        const off = i * 4;
        const r = rgba[off];
        const g = rgba[off + 1];
        const b = rgba[off + 2];
        const key = (r << 16) | (g << 8) | b;
        let idx = colorMap.get(key);
        if (idx === undefined) {
            if (palette.length < 256) {
                idx = palette.length;
                palette.push([r, g, b]);
                colorMap.set(key, idx);
            } else {
                let bestDist = Infinity;
                idx = 0;
                for (let p = 0; p < palette.length; p++) {
                    const pal = palette[p];
                    const dr = pal[0] - r;
                    const dg = pal[1] - g;
                    const db = pal[2] - b;
                    const d = dr * dr + dg * dg + db * db;
                    if (d < bestDist) {
                        bestDist = d;
                        idx = p;
                        if (d === 0) break;
                    }
                }
                colorMap.set(key, idx);
            }
        }
        indexed[i] = idx;
    }

    return { palette, indexed };
}

export interface GenerateGifOptions {
    startTick?: number;
    endTick?: number;
    step?: number;
    fps?: number;
    cell?: number;
    showStructures?: boolean;
    showActions?: boolean;
    onProgress?: (done: number, total: number) => void;
}

/**
 * Generate animated GIF from replay document.
 */
export function generateReplayGif(doc: ReplayDoc, options: GenerateGifOptions = {}): Buffer {
    const timeline = buildTimeline(doc);
    const cell = Math.max(2, Math.min(16, options.cell ?? 4));
    const width = timeline.width * cell;
    const height = timeline.height * cell;
    const fps = Math.max(1, Math.min(60, options.fps ?? 10));
    const step = Math.max(1, options.step ?? 1);
    const delayMs = 1000 / fps;

    const minTick = 0;
    const maxTick = Math.max(0, timeline.length - 1);
    const startTick = Math.max(minTick, Math.min(maxTick, options.startTick ?? minTick));
    const endTick = Math.max(startTick, Math.min(maxTick, options.endTick ?? maxTick));

    const sideColors = doc.meta.players.map(
        (p, i) => p.color ?? FALLBACK_SIDE_COLOR[i] ?? NEUTRAL,
    );

    const gif = new GifEncoder(width, height);
    const canvas = new SoftwareCanvas(width, height);

    const totalFrames = Math.floor((endTick - startTick) / step) + 1;
    let framesDone = 0;

    for (let i = startTick; i <= endTick; i += step) {
        const state = stateAt(timeline, i);
        canvas.clearRect(0, 0, width, height);
        drawBoard(canvas, timeline, state, cell, sideColors, {
            showStructures: options.showStructures !== false,
            showActions: options.showActions !== false,
            drawBackground: true,
        });

        const { palette, indexed } = quantizeFrame(canvas.data);
        gif.addFrame(indexed, palette, delayMs);
        framesDone++;
        options.onProgress?.(framesDone, totalFrames);
    }

    return gif.finish();
}
