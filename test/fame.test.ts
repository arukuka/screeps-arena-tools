import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
    formatDuration,
    getNextUtcReset,
    loadFameConfig,
    saveDefaultFameConfig,
    type ArenaFameStatus,
} from "../src/fame.js";

test("formatDuration converts milliseconds into hh:mm:ss", () => {
    assert.equal(formatDuration(0), "00:00:00");
    assert.equal(formatDuration(1000), "00:00:01");
    assert.equal(formatDuration(65000), "00:01:05");
    assert.equal(formatDuration(3665000), "01:01:05");
    assert.equal(formatDuration(36000000), "10:00:00");
});

test("getNextUtcReset computes next UTC midnight", () => {
    const { nextResetUtc, nextResetMs } = getNextUtcReset();
    assert.ok(nextResetMs > 0);
    assert.ok(nextResetMs <= 24 * 60 * 60 * 1000);

    const resetDate = new Date(nextResetUtc);
    assert.equal(resetDate.getUTCHours(), 0);
    assert.equal(resetDate.getUTCMinutes(), 0);
    assert.equal(resetDate.getUTCSeconds(), 0);
});

test("saveDefaultFameConfig and loadFameConfig round-trip", () => {
    const tempConfigPath = resolve(process.cwd(), "test-fame.config.json");
    try {
        const mockArenas: ArenaFameStatus[] = [
            {
                arenaId: "6a86d8c454a3948a1e35f90c",
                arenaName: "Pain and Gain",
                advanced: false,
                unlocked: true,
                canPlay: true,
                isFinished: false,
                gamesPlayed: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                famePoints: 0,
                rewardsLevel: 0,
                rewardsTaken: false,
                rewards: [],
                nextResetUtc: new Date().toISOString(),
                nextResetMs: 10000,
                games: [],
                sourceFolder: "/path/to/code",
            },
            {
                arenaId: "6a86d8c454a3948a1e35f90d",
                arenaName: "Pain and Gain",
                advanced: true,
                unlocked: false,
                canPlay: false,
                isFinished: false,
                gamesPlayed: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                famePoints: 0,
                rewardsLevel: 0,
                rewardsTaken: false,
                rewards: [],
                nextResetUtc: new Date().toISOString(),
                nextResetMs: 10000,
                games: [],
            },
        ];

        saveDefaultFameConfig(mockArenas, tempConfigPath, { stopOnDefeat: true });
        assert.ok(existsSync(tempConfigPath));

        const loaded = loadFameConfig(tempConfigPath);
        assert.equal(loaded.stopOnDefeat, true);
        assert.equal(loaded.continuous, true);
        assert.equal(loaded.arenas?.length, 2);
        assert.equal(loaded.arenas?.[0]?.id, "6a86d8c454a3948a1e35f90c");
        assert.equal(loaded.arenas?.[0]?.enabled, true);
        assert.equal(loaded.arenas?.[0]?.sourceFolder, "/path/to/code");
        assert.equal(loaded.arenas?.[1]?.enabled, false);
    } finally {
        if (existsSync(tempConfigPath)) {
            unlinkSync(tempConfigPath);
        }
    }
});
