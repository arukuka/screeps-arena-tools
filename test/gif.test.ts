import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GifEncoder, generateReplayGif, quantizeFrame } from "../src/gif.js";
import { SoftwareCanvas, parseRgba } from "../src/software_canvas.js";
import { readReplay } from "../src/replay_io.js";
import { handleRequest, resolveServeOptions } from "../src/serve.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = CURRENT_DIR.endsWith("dist/test") || CURRENT_DIR.endsWith("dist\\test")
    ? resolve(CURRENT_DIR, "../..")
    : resolve(CURRENT_DIR, "..");

test("parseRgba parses hex and rgb/rgba formats", () => {
    assert.deepEqual(parseRgba("#ff0000"), [255, 0, 0, 255]);
    assert.deepEqual(parseRgba("#0f0"), [0, 255, 0, 255]);
    assert.deepEqual(parseRgba("rgb(10, 20, 30)"), [10, 20, 30, 255]);
    assert.deepEqual(parseRgba("rgba(10, 20, 30, 0.5)"), [10, 20, 30, 128]);
});

test("SoftwareCanvas rasterizes solid rects and alpha blends", () => {
    const canvas = new SoftwareCanvas(10, 10);
    canvas.fillStyle = "#000000";
    canvas.fillRect(0, 0, 10, 10);
    assert.equal(canvas.data[0], 0);
    assert.equal(canvas.data[1], 0);
    assert.equal(canvas.data[2], 0);
    assert.equal(canvas.data[3], 255);

    // Semi-transparent red overlay
    canvas.fillStyle = "rgba(255, 0, 0, 0.5)";
    canvas.fillRect(0, 0, 10, 10);
    assert.ok(canvas.data[0] > 100 && canvas.data[0] < 150); // blended red ~ 128
    assert.equal(canvas.data[1], 0);
    assert.equal(canvas.data[2], 0);
});

test("SoftwareCanvas draws lines and circles", () => {
    const canvas = new SoftwareCanvas(20, 20);
    canvas.beginPath();
    canvas.arc(10, 10, 5, 0, Math.PI * 2);
    canvas.fillStyle = "#ffffff";
    canvas.fill();

    // Center pixel should be white
    const centerIdx = (10 * 20 + 10) * 4;
    assert.equal(canvas.data[centerIdx], 255);
    assert.equal(canvas.data[centerIdx + 1], 255);
    assert.equal(canvas.data[centerIdx + 2], 255);

    // Far corner should be unpainted (0, 0, 0, 0)
    assert.equal(canvas.data[0], 0);
});

test("quantizeFrame maps image data to <= 256 colors", () => {
    const data = new Uint8ClampedArray(4 * 4 * 4); // 4x4 image
    data.fill(255); // all white
    data[0] = 255; data[1] = 0; data[2] = 0; // first pixel red

    const { palette, indexed } = quantizeFrame(data);
    assert.ok(palette.length <= 256);
    assert.equal(indexed.length, 16);
    assert.notEqual(indexed[0], indexed[1]);
});

test("GifEncoder produces valid GIF89a binary structure", () => {
    const enc = new GifEncoder(10, 10);
    const frame = new Uint8Array(100);
    frame.fill(1);
    const palette = [[0, 0, 0], [255, 0, 0]];

    enc.addFrame(frame, palette, 100);
    enc.addFrame(frame, palette, 100);

    const buf = enc.finish();
    assert.ok(buf.length > 50);

    // Header check
    assert.equal(buf.subarray(0, 6).toString("ascii"), "GIF89a");

    // Dimensions in Logical Screen Descriptor
    assert.equal(buf.readUInt16LE(6), 10);
    assert.equal(buf.readUInt16LE(8), 10);

    // Trailer check (last byte 0x3B)
    assert.equal(buf[buf.length - 1], 0x3b);
});

test("generateReplayGif creates multi-frame animated GIF from replay fixture", () => {
    const fixturePath = resolve(ROOT, "test/fixtures/XTTCQ7DA4T.replay.json.gz");
    const doc = readReplay(fixturePath);
    assert.ok(doc);

    const gifBuffer = generateReplayGif(doc, {
        startTick: 0,
        endTick: 10,
        step: 2,
        fps: 10,
        cell: 3,
    });

    assert.ok(Buffer.isBuffer(gifBuffer));
    assert.ok(gifBuffer.length > 1000);
    assert.equal(gifBuffer.subarray(0, 6).toString("ascii"), "GIF89a");
    assert.equal(gifBuffer[gifBuffer.length - 1], 0x3b);

    // Width & height should be width * cell = 100 * 3 = 300
    assert.equal(gifBuffer.readUInt16LE(6), 300);
    assert.equal(gifBuffer.readUInt16LE(8), 300);
});

test("server /api/gif endpoint returns image/gif attachment", async () => {
    const opts = resolveServeOptions(ROOT, {
        replayDir: resolve(ROOT, "test/fixtures"),
    });

    const req = new EventEmitter() as unknown as IncomingMessage;
    (req as any).url = "/api/gif?file=XTTCQ7DA4T.replay.json.gz&start=0&end=4&step=2&cell=3";
    (req as any).method = "GET";

    let statusCode = 0;
    let headers: Record<string, string> = {};
    const chunks: Buffer[] = [];

    const res = {
        writeHead(code: number, h: Record<string, string>) {
            statusCode = code;
            headers = h;
            return this;
        },
        end(data?: Buffer) {
            if (data) chunks.push(data);
        },
    } as unknown as ServerResponse;

    await handleRequest(opts, req, res);

    assert.equal(statusCode, 200);
    assert.equal(headers["content-type"], "image/gif");
    assert.ok(headers["content-disposition"]?.includes(".gif"));
    const body = Buffer.concat(chunks);
    assert.equal(body.subarray(0, 6).toString("ascii"), "GIF89a");
    assert.equal(body[body.length - 1], 0x3b);
});
