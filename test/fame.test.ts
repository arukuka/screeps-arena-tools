import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
    formatDuration,
    getNextUtcReset,
    loadFameConfig,
    parseFameGames,
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

test("parseFameGames correctly evaluates wins, losses, draws, and sorts matches latest first", () => {
    const myUserId = "user_me";
    const oppUserId = "user_opp";

    const rawGames = [
        // Match 1 (older): me is usersCode[0], score 1 => WIN
        {
            _id: "match_1",
            createdAt: "2026-09-05T01:00:00.000Z",
            codes: [
                { _id: "code_me", user: myUserId },
                { _id: "code_opp", user: oppUserId },
            ],
            users: [
                { _id: myUserId, username: "me" },
                { _id: oppUserId, username: "opp" },
            ],
            game: {
                _id: "match_1",
                status: "finished",
                createdAt: "2026-09-05T01:00:00.000Z",
                usersCode: ["code_me", "code_opp"],
                result: { winner: 1 },
                meta: { ticks: 500 },
            },
        },
        // Match 2 (newer): me is usersCode[0], score 0 => LOSS
        {
            _id: "match_2",
            createdAt: "2026-09-05T02:00:00.000Z",
            codes: [
                { _id: "code_me", user: myUserId },
                { _id: "code_opp", user: oppUserId },
            ],
            users: [
                { _id: myUserId, username: "me" },
                { _id: oppUserId, username: "opp" },
            ],
            game: {
                _id: "match_2",
                status: "finished",
                createdAt: "2026-09-05T02:00:00.000Z",
                usersCode: ["code_me", "code_opp"],
                result: { winner: 0 },
                meta: { ticks: 1200 },
            },
        },
        // Match 3 (latest): opp is usersCode[0], score 0 => opp lost, so me WON
        {
            _id: "match_3",
            createdAt: "2026-09-05T03:00:00.000Z",
            codes: [
                { _id: "code_opp", user: oppUserId },
                { _id: "code_me", user: myUserId },
            ],
            users: [
                { _id: myUserId, username: "me" },
                { _id: oppUserId, username: "opp" },
            ],
            game: {
                _id: "match_3",
                status: "finished",
                createdAt: "2026-09-05T03:00:00.000Z",
                usersCode: ["code_opp", "code_me"],
                result: { winner: 0 },
                meta: { ticks: 800 },
            },
        },
        // Match 4 (draw): score 0.5 => DRAW
        {
            _id: "match_4",
            createdAt: "2026-09-05T02:30:00.000Z",
            codes: [
                { _id: "code_me", user: myUserId },
                { _id: "code_opp", user: oppUserId },
            ],
            users: [
                { _id: myUserId, username: "me" },
                { _id: oppUserId, username: "opp" },
            ],
            game: {
                _id: "match_4",
                status: "finished",
                createdAt: "2026-09-05T02:30:00.000Z",
                usersCode: ["code_me", "code_opp"],
                result: { winner: 0.5 },
                meta: { ticks: 2000 },
            },
        },
    ];

    const { games, wins, losses, draws } = parseFameGames(rawGames, myUserId);

    assert.equal(wins, 2);
    assert.equal(losses, 1);
    assert.equal(draws, 1);
    assert.equal(games.length, 4);

    // Verify sorted latest first: match_3 (03:00), match_4 (02:30), match_2 (02:00), match_1 (01:00)
    assert.equal(games[0]?._id, "match_3");
    assert.equal(games[0]?.won, true);
    assert.equal(games[0]?.opponent, "opp");

    assert.equal(games[1]?._id, "match_4");
    assert.equal(games[1]?.draw, true);

    assert.equal(games[2]?._id, "match_2");
    assert.equal(games[2]?.won, false);

    assert.equal(games[3]?._id, "match_1");
    assert.equal(games[3]?.won, true);
});
