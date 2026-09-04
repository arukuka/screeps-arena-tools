/** Library entry point. For CLI, see `src/cli.ts`. */
export { matchUrl, parseMatchRef } from "./arena_url.js";
export { createNormalizer, normalizeMatch, readGameMeta, REPLAY_FORMAT, REPLAY_VERSION } from "./normalize.js";
export { indexExtensions, splitLogLine } from "./extensions.js";
export { decodeTerrain, encodeTerrain } from "./terrain.js";
export { applyFrame, buildTimeline, bodyCounts, bodySize, parseBody, sideStats, stateAt } from "./timeline.js";
export { describeReplay, isReplayDoc, readReplay, writeReplay } from "./replay_io.js";
export { fetchMatch, fetchGameWithSession } from "./fetch_match.js";
export { syncReplays, watchReplays, openArenaSession, getExistingMatchIds } from "./sync.js";
export { getCurrentUser, getSeasonArenas, resolveArena, fetchRatingHistory } from "./arena_api.js";
export { drawBoard, drawStructures, drawCreeps, drawActions, drawTerrain } from "./board_render.js";
export { SoftwareCanvas } from "./software_canvas.js";
export { GifEncoder, generateReplayGif } from "./gif.js";
export * from "./types.js";
