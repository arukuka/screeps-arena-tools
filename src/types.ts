/**
 * Type definitions for Screeps Arena Tools.
 */

export interface PlayerInfo {
    slot: string;
    side: number;
    username: string | null;
    userId: string | null;
    color: string | null;
    codeVersion: number | null;
}

export interface MatchResult {
    winner: number | null;
    winnerName: string | null;
    draw: boolean;
    status?: string | null;
    raw?: number | null;
}

/**
 * Console log retrieval statistics.
 *
 * Without this, "the match produced no console output" and "log retrieval
 * failed" are indistinguishable once `logs` comes out empty. Telemetry
 * emitted by bots as `@namespace <payload>` travels through the same
 * endpoint, so a silent failure here silently empties `ticks[].e` as well.
 */
export interface LogChunkStats {
    /** Chunks the fetcher attempted to retrieve. */
    requested: number;
    /** Chunks retrieved successfully. */
    fetched: number;
    /** Chunks that failed to retrieve. */
    failed: number;
    /** Distinct failure reasons, capped at a few entries. */
    errors: string[];
}

export interface ReplayMeta {
    shortId: string | null;
    gameId: string | null;
    url: string | null;
    fetchedAt: string | null;
    createdAt: string | null;
    arenaId: string | null;
    ticksLimit: number | null;
    ticks: number;
    players: PlayerInfo[];
    result: MatchResult;
    width: number;
    height: number;
    /** Console log retrieval statistics. `null` when not recorded. */
    logChunks: LogChunkStats | null;
    /** Origin producer identifier, e.g. "screeps-arena-sim". Optional. */
    producer?: string | null;
}

export interface ReplayObject {
    id: string;
    kind: string;
    side: number | null;
    x: number;
    y: number;
    hits: number;
    hitsMax: number;
    energy: number;
    energyCapacity: number;
    controlledBy?: unknown | null;
}

export type TickBirthTuple = [
    id: string,
    side: number | null,
    x: number,
    y: number,
    hits: number,
    hitsMax: number,
    body: string,
    spawning: number,
];

export type TickUpdateTuple = [
    id: string,
    x: number,
    y: number,
    hits: number,
    fatigue: number,
    spawning: number,
];

export type TickBodyTuple = [id: string, body: string];

export type TickActionTuple = [id: string, code: string, tx?: number, ty?: number];

export type TickStructTuple = [id: string, hits: number, energy: number];

export type TickOwnerTuple = [id: string, side: number | null];

export interface ReplayTick {
    k: number;
    n?: TickBirthTuple[];
    u?: TickUpdateTuple[];
    b?: TickBodyTuple[];
    x?: string[];
    a?: TickActionTuple[];
    s?: TickStructTuple[];
    w?: TickOwnerTuple[];
    e?: Record<string, unknown[]>;
}

export interface ExtensionIndexEntry {
    count: number;
    firstTick: number;
    lastTick: number;
}

export type ExtensionIndex = Record<string, ExtensionIndexEntry>;

export interface ReplayDoc {
    format: string;
    version: number;
    meta: ReplayMeta;
    terrain: string;
    objects: ReplayObject[];
    ticks: ReplayTick[];
    logs: Record<string, string>;
    extensions: ExtensionIndex;
}

export interface CreepState {
    id: string;
    side: number | null;
    x: number;
    y: number;
    hits: number;
    hitsMax: number;
    body: string;
    spawning: number;
    fatigue: number;
}

export interface StructureState {
    hits: number;
    energy: number;
}

export interface BoardState {
    tick: number;
    creeps: Map<string, CreepState>;
    struct: Map<string, StructureState>;
    owner: Map<string, number | null>;
    actions: TickActionTuple[];
    ext?: Record<string, unknown[]> | null;
}

export interface Timeline {
    doc: ReplayDoc;
    width: number;
    height: number;
    terrain: Uint8Array;
    objectById: Map<string, ReplayObject>;
    base: BoardState;
    keyframes: BoardState[];
    length: number;
}

export interface SideStats {
    creeps: number;
    hits: number;
    hitsMax: number;
    parts: number;
    energy: number;
    structures: number;
    flags: number;
}

export interface BodyPartInfo {
    code: string;
    name: string;
    count: number;
}

export interface PluginToggle {
    id: string;
    label: string;
    default?: boolean;
    plugin?: string;
}

export interface PluginLegend {
    color: string;
    label: string;
    line?: boolean;
}

export interface PluginPanel {
    id: string;
    title?: string;
    render: (el: HTMLElement, api: PluginApi) => void;
    plugin?: string;
}

export interface ArenaPlugin {
    name: string;
    requires?: string[];
    toggles?: PluginToggle[];
    legend?: PluginLegend[];
    panels?: PluginPanel[];
    drawOverlay?: (api: PluginApi) => void;
}

export interface PluginApi {
    ctx: CanvasRenderingContext2D;
    cell: number;
    doc: ReplayDoc;
    timeline: Timeline;
    state: BoardState;
    tick: number;
    index: number;
    ext: Record<string, unknown[]> | null | undefined;
    extAt: (tick: number) => Record<string, unknown[]> | null;
    selected: string | null;
    sideColor: (side: number | null | undefined) => string;
    fade: (hex: string, alpha: number) => string;
    isToggled: (id: string) => boolean;
}

export interface NormalizerInit {
    gameData?: any;
    shortId?: string | null;
    gameId?: string | null;
    fetchedAt?: string | null;
}

export interface Normalizer {
    pushFrames(frames: ReadonlyArray<any>): void;
    pushLogs(chunk: any): void;
    /**
     * Record the outcome of one console log chunk request.
     *
     * Call once per attempted chunk, whether it succeeded or not, so that
     * `meta.logChunks` can tell an empty log apart from a failed fetch.
     */
    noteLogChunk(result: { ok: boolean; status?: number; statusText?: string }): void;
    finish(): ReplayDoc;
}

export interface ProgressInfo {
    phase: string;
    done?: number;
    total?: number;
    message?: string;
}

export interface FetchMatchOptions {
    onProgress?: (info: ProgressInfo) => void;
}

export interface ServeOptions {
    port: number;
    host?: string;
    viewerDir: string;
    distViewerDir?: string;
    srcDir: string;
    replayDir: string;
    pluginDir: string | null;
}

export interface ReplayListItem {
    file: string;
    bytes: number;
    modified: string;
    meta: Partial<ReplayMeta> | null;
}

export interface ArenaSummary {
    _id: string;
    name: string;
    advanced: boolean;
    folderName?: string;
    active?: boolean;
    rating?: number;
    games?: number;
    rank?: number;
}

export interface RatingHistoryItem {
    _id: string;
    gameId: string;
    shortId?: string | null;
    createdAt: string;
    ticks: number;
    winner: number | null;
    draw?: boolean;
    users: { _id: string; username: string }[];
    codes: { _id: string; user: string; version: number }[];
    ratingChange?: {
        previousRating: number;
        rating: number;
        previousRank: number | null;
        rank: number | null;
    };
    hasReplay: boolean;
}

export interface SyncOptions {
    arena?: string;
    limit?: number;
    replayDir?: string;
    onProgress?: (info: ProgressInfo) => void;
    onMatchSynced?: (item: RatingHistoryItem, filePath: string, isNew: boolean) => void;
}

export interface WatchOptions extends SyncOptions {
    intervalMs?: number;
    signal?: AbortSignal;
}
