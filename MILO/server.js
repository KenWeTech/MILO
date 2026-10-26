require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');
const bonjour = require('bonjour')();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const fuzz = require('fuzzball');
const mm = require('music-metadata');
const Organizer = require('./organizer');
const { fetchProviderPlaylistTracks } = require('./playlist-importers');

const app = express();

const PORT = process.env.PORT || 8088;
const SECRET_KEY = process.env.FLASK_SECRET_KEY || 'super-secret-production-key';
const DB_PATH = normalizeFilesystemPath(String(process.env.DB_PATH || path.join(__dirname, 'data', 'milo.db')));
const MASTER_POOL_DIR = normalizeFilesystemPath(String(process.env.MASTER_POOL_DIR || 'C:/Media/Music/MasterPool'));

const LIBRARY_PATH = normalizeFilesystemPath(String(process.env.LIBRARY_PATH || path.join(process.cwd(), 'MILO_Libraries')));
const SPOTIPY_CLIENT_ID = process.env.SPOTIPY_CLIENT_ID || '';
const SPOTIPY_CLIENT_SECRET = process.env.SPOTIPY_CLIENT_SECRET || '';
const APPLE_DEVELOPER_TOKEN = process.env.APPLE_DEVELOPER_TOKEN || '';

function resolveUserLibraryPath(userOrPath) {
    const raw = String(userOrPath && typeof userOrPath === 'object' ? userOrPath.library_path || '' : userOrPath || '').trim();
    if (!raw) throw new Error('User library path is required.');

    const normalizedInput = process.platform === 'win32' ? raw.replace(/\//g, '\\') : raw.replace(/\\/g, '/');
    if (process.platform !== 'win32' && /^[A-Za-z]:\//.test(normalizedInput)) {
        throw new Error('Use an absolute path for this operating system (for example, /media/music/username on Linux/Docker).');
    }
    if (path.isAbsolute(normalizedInput)) return normalizeFilesystemPath(normalizedInput);
    const resolved = normalizeFilesystemPath(LIBRARY_PATH, normalizedInput);
    if (!pathSameOrInside(resolved, LIBRARY_PATH)) {
        throw new Error('Relative library folders must remain inside LIBRARY_PATH. Enter an absolute path to use a folder elsewhere.');
    }
    return resolved;
}

function normalizeFilesystemPath(...values) {
    const parts = values.map(value => String(value == null ? '' : value).trim().replace(/\\/g, '/'));
    if (!parts.length || !parts[0]) return '';
    return path.resolve(...parts).replace(/\\/g, '/');
}

function displayFilesystemPath(value) {
    return String(value == null ? '' : value).replace(/\\/g, '/');
}

function sameResolvedPath(first, second) {
    const a = normalizeFilesystemPath(first);
    const b = normalizeFilesystemPath(second);
    return (process.platform === 'win32' ? a.toLowerCase() : a) === (process.platform === 'win32' ? b.toLowerCase() : b);
}

const MASTER_SCAN_SCHEDULES = [360, 720, 1440, 4320, 10080, 43200];
const INCREMENTAL_SCAN_SCHEDULES = [30, 60, 120, 240, 360, 720, 1440, 4320, 10080];
const USER_SYNC_SCHEDULES = [60, 180, 360, 720, 1440, 10080, 43200];
const GLOBAL_SYNC_COOLDOWN_SECONDS = 5 * 60;

function normalizeIntervalToSchedule(value, schedules) {
    const requested = Number.parseInt(value, 10);
    if (!Number.isFinite(requested) || requested <= 0) return 0;
    return schedules.find(schedule => schedule >= requested) || 0;
}

const DRIVEPOOL_DRIVES = process.env.DRIVEPOOL_DRIVES
    ? process.env.DRIVEPOOL_DRIVES.split(',').map(d => d.trim().replace(/\\/g, '/').replace(/\/+$/g, '')).filter(Boolean)
    : [];

app.set('view engine', 'ejs');
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/api/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.status(200).json({ ok: true, service: 'MILO' });
});

app.use(express.static('public'));

app.use(session({
    secret: SECRET_KEY,
    resave: false,
    saveUninitialized: false
}));

const db = new Database(DB_PATH, { timeout: 15000 });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const historyDb = new Database(normalizeFilesystemPath(path.dirname(DB_PATH), 'sync_history.db'), { timeout: 15000 });
historyDb.pragma('journal_mode = WAL');

function initDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            library_path TEXT NOT NULL,
            sync_provider TEXT,
            sync_url TEXT,
            index_mode TEXT DEFAULT 'standard',
            auto_sync INTEGER DEFAULT 0,
            one_for_one INTEGER DEFAULT 0,
            sync_interval INTEGER DEFAULT 0,
            last_sync REAL DEFAULT 0,
            spotify_client_id TEXT,
            spotify_client_secret TEXT,
            apple_dev_token TEXT,
            text_playlist_api_key_hash TEXT
        );

        CREATE TABLE IF NOT EXISTS catalog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            artist TEXT,
            album TEXT,
            search_str TEXT NOT NULL,
            added_at REAL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS scan_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS user_tracks (
            user_id INTEGER,
            track_id INTEGER,
            PRIMARY KEY (user_id, track_id),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(track_id) REFERENCES catalog(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS missing_track_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            query TEXT NOT NULL,
            source TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_text_playlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            query TEXT NOT NULL,
            normalized_query TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, normalized_query),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_user_text_playlist_user ON user_text_playlist(user_id, id);
    `);

    const columns = [
        { name: 'auto_sync', def: "INTEGER DEFAULT 0" },
        { name: 'one_for_one', def: "INTEGER DEFAULT 0" },
        { name: 'sync_interval', def: "INTEGER DEFAULT 0" },
        { name: 'last_sync', def: "REAL DEFAULT 0" },
        { name: 'spotify_client_id', def: "TEXT" },
        { name: 'spotify_client_secret', def: "TEXT" },
        { name: 'apple_dev_token', def: "TEXT" },
        { name: 'text_playlist_api_key_hash', def: "TEXT" }
    ];

    for (const col of columns) {
        try {
            db.prepare(`SELECT ${col.name} FROM users LIMIT 1`).get();
        } catch (e) {
            db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.def}`);
        }
    }

    const adminExists = db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get();
    if (!adminExists) {

        const targetDir = normalizeFilesystemPath(LIBRARY_PATH, 'Admin_Library');
        fs.mkdirSync(targetDir, { recursive: true });
        const hash = bcrypt.hashSync("admin", 10);
        db.prepare(
            "INSERT INTO users (username, password_hash, role, library_path, index_mode) VALUES (?, ?, ?, ?, ?)"
        ).run("admin", hash, "admin", targetDir, "standard");
    }

    const missingLogColumns = db.pragma('table_info(missing_track_logs)');
    if (!missingLogColumns.some(column => column.name === 'normalized_query')) {
        db.exec("ALTER TABLE missing_track_logs ADD COLUMN normalized_query TEXT NOT NULL DEFAULT ''");
    }
    const existingMissingLogs = db.prepare('SELECT id, user_id, query FROM missing_track_logs ORDER BY id DESC').all();
    const seenMissingLogKeys = new Set();
    db.transaction(() => {
        for (const row of existingMissingLogs) {
            const normalizedQuery = normalizeTextPlaylistQuery(row.query);

            if (!normalizedQuery) {
                db.prepare('DELETE FROM missing_track_logs WHERE id = ?').run(row.id);
                continue;
            }
            const key = `${row.user_id}:${normalizedQuery}`;
            if (seenMissingLogKeys.has(key)) {
                db.prepare('DELETE FROM missing_track_logs WHERE id = ?').run(row.id);
            } else {
                seenMissingLogKeys.add(key);
                db.prepare('UPDATE missing_track_logs SET normalized_query = ? WHERE id = ?').run(normalizedQuery, row.id);
            }
        }
    })();
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_missing_track_logs_user_query ON missing_track_logs(user_id, normalized_query)');

    historyDb.exec(`
        CREATE TABLE IF NOT EXISTS playlist_cache (
            user_id INTEGER,
            source_type TEXT,
            raw_query TEXT,
            track_id INTEGER,
            PRIMARY KEY (user_id, source_type, raw_query)
        );

        CREATE TABLE IF NOT EXISTS removed_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            track_id INTEGER,
            removed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS missing_log_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            log_id INTEGER,
            query TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'unknown',
            action TEXT NOT NULL,
            track_id INTEGER,
            track_title TEXT,
            track_artist TEXT,
            already_assigned INTEGER NOT NULL DEFAULT 0,
            details TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            undone_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_missing_log_history_user ON missing_log_history(user_id, id DESC);
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS background_task_history (
            task_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            task_type TEXT NOT NULL DEFAULT '',
            label TEXT NOT NULL,
            user_id INTEGER,
            username TEXT NOT NULL DEFAULT '',
            requested_by TEXT NOT NULL DEFAULT '',
            trigger_source TEXT NOT NULL DEFAULT 'manual',
            trigger_detail TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'queued',
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            completed_at INTEGER,
            duration_ms INTEGER,
            message TEXT NOT NULL DEFAULT '',
            error_trace TEXT NOT NULL DEFAULT '',
            result_summary TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_background_task_history_completed ON background_task_history(completed_at DESC, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_background_task_history_status ON background_task_history(status, created_at DESC);
    `);

    const masterScheduleRow = db.prepare("SELECT value FROM scan_settings WHERE key = 'master_scan_interval'").get();
    if (masterScheduleRow) {
        const normalizedSchedule = normalizeIntervalToSchedule(masterScheduleRow.value, MASTER_SCAN_SCHEDULES);
        if (String(normalizedSchedule) !== String(masterScheduleRow.value)) {
            db.prepare("UPDATE scan_settings SET value = ? WHERE key = 'master_scan_interval'").run(String(normalizedSchedule));
        }
    }
    const incrementalScheduleRow = db.prepare("SELECT value FROM scan_settings WHERE key = 'incremental_scan_interval'").get();
    if (incrementalScheduleRow) {
        const normalizedSchedule = normalizeIntervalToSchedule(incrementalScheduleRow.value, INCREMENTAL_SCAN_SCHEDULES);
        if (String(normalizedSchedule) !== String(incrementalScheduleRow.value)) {
            db.prepare("UPDATE scan_settings SET value = ? WHERE key = 'incremental_scan_interval'").run(String(normalizedSchedule));
        }
    }
    const usersWithIntervals = db.prepare('SELECT id, sync_interval FROM users WHERE sync_interval > 0').all();
    const updateUserSchedule = db.prepare('UPDATE users SET sync_interval = ? WHERE id = ?');
    for (const user of usersWithIntervals) {
        const normalizedSchedule = normalizeIntervalToSchedule(user.sync_interval, USER_SYNC_SCHEDULES);
        if (normalizedSchedule !== Number(user.sync_interval)) updateUserSchedule.run(normalizedSchedule, user.id);
    }
}

initDb();

function normalizeStoredCatalogPaths() {
    const rows = db.prepare('SELECT id, file_path FROM catalog ORDER BY id').all();
    const groups = new Map();
    for (const row of rows) {
        const normalizedPath = normalizeFilesystemPath(row.file_path);
        const key = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    const merge = db.transaction((group, canonicalPath, keeperId) => {
        for (const duplicate of group) {
            if (Number(duplicate.id) === Number(keeperId)) continue;
            db.prepare(`INSERT OR IGNORE INTO user_tracks (user_id, track_id)
                SELECT user_id, ? FROM user_tracks WHERE track_id = ?`).run(keeperId, duplicate.id);
            db.prepare('DELETE FROM catalog WHERE id = ?').run(duplicate.id);
        }
        db.prepare('UPDATE catalog SET file_path = ? WHERE id = ?').run(canonicalPath, keeperId);
    });
    for (const group of groups.values()) {
        if (!group.length) continue;
        const canonicalPath = normalizeFilesystemPath(group[0].file_path);
        const keeper = group.find(row => row.file_path === canonicalPath) || group[0];
        if (group.length === 1 && keeper.file_path === canonicalPath) continue;
        try { merge(group, canonicalPath, keeper.id); }
        catch (error) {
            console.warn(`[Catalog] Could not fully normalize stored path ${canonicalPath}: ${error.message}`);
        }
    }
}

normalizeStoredCatalogPaths();

function saveBackgroundTaskHistory(task) {
    if (!task || !task.id) return;
    try {
        const completedAt = Number(task.completedAt) || null;
        const startedAt = Number(task.startedAt) || null;
        const createdAt = Number(task.createdAt) || Date.now();
        const user = task.payload && task.payload.user ? task.payload.user : null;
        const username = String(user?.username || task.username || task.requestedByUsername || '');
        const status = task.status === 'auto_completed' ? 'completed' : String(task.status || 'queued');
        const triggerSource = task.scheduled ? 'scheduled cron' : 'manual';
        const triggerDetail = String(task.trigger || task.payload?.sourceType || task.label || '').slice(0, 500);
        const message = String(task.message || task.error || '').slice(0, 5000);
        const errorTrace = String(task.errorTrace || (status === 'error' ? task.error || task.message || '' : '')).slice(0, 30000);
        let resultSummary = '';
        if (task.result != null) {
            try { resultSummary = JSON.stringify(task.result).slice(0, 5000); }
            catch (_) { resultSummary = String(task.result).slice(0, 5000); }
        }
        const durationMs = startedAt && completedAt ? Math.max(0, completedAt - startedAt) : null;
        db.prepare(`
            INSERT INTO background_task_history (
                task_id, kind, task_type, label, user_id, username, requested_by,
                trigger_source, trigger_detail, status, created_at, started_at,
                completed_at, duration_ms, message, error_trace, result_summary, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET
                kind = excluded.kind, task_type = excluded.task_type, label = excluded.label,
                user_id = excluded.user_id, username = excluded.username, requested_by = excluded.requested_by,
                trigger_source = excluded.trigger_source, trigger_detail = excluded.trigger_detail,
                status = excluded.status, created_at = excluded.created_at, started_at = excluded.started_at,
                completed_at = excluded.completed_at, duration_ms = excluded.duration_ms,
                message = excluded.message, error_trace = excluded.error_trace,
                result_summary = excluded.result_summary, updated_at = excluded.updated_at
        `).run(
            String(task.id), String(task.kind || 'task'), String(task.scanType || task.kind || ''),
            String(task.label || 'MILO background task').slice(0, 500),
            task.userId == null ? null : Number(task.userId), username.slice(0, 256),
            String(task.requestedByUsername || '').slice(0, 256), triggerSource, triggerDetail,
            status, createdAt, startedAt, completedAt, durationMs,
            message, errorTrace, resultSummary, Date.now()
        );
    } catch (error) {
        console.warn('[Task History] Could not save background task history:', error.message);
    }
}

function startStandaloneTaskHistory(job, requester, label, triggerDetail = '') {
    if (!job || typeof job !== 'object') return job;
    job.historyTaskId = job.historyTaskId || crypto.randomUUID();
    job.historyCreatedAt = Number(job.historyCreatedAt || job.createdAt || job.startedAt) || Date.now();
    job.historyRequestedByUserId = requester && requester.id != null ? Number(requester.id) : null;
    job.historyRequestedByUsername = String(requester && requester.username || 'System');
    job.historyLabel = String(label || job.label || job.task || 'Background task');
    job.historyTriggerDetail = String(triggerDetail || job.task || 'manual');
    persistStandaloneTaskHistory(job);
    return job;
}

function persistStandaloneTaskHistory(job) {
    if (!job || !job.historyTaskId) return;
    saveBackgroundTaskHistory({
        id: job.historyTaskId,
        kind: job.historyKind || 'maintenance',
        scanType: job.task || job.historyKind || 'maintenance',
        label: job.historyLabel || job.task || 'Background task',
        userId: job.historyRequestedByUserId,
        username: job.historyRequestedByUsername || 'System',
        requestedByUsername: job.historyRequestedByUsername || '',
        scheduled: job.scheduled === true,
        trigger: job.historyTriggerDetail || job.trigger || job.task || 'manual',
        status: job.status,
        createdAt: job.historyCreatedAt || job.createdAt || job.startedAt || Date.now(),
        startedAt: job.startedAt || job.historyCreatedAt || job.createdAt || Date.now(),
        completedAt: job.completedAt,
        message: job.message || '',
        errorTrace: job.errorTrace || (job.status === 'error' ? job.message || '' : ''),
        result: job.result
    });
}

function normalizeTextPlaylistQuery(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
}

const WANTED_TRACKS_FILE = normalizeFilesystemPath(path.dirname(DB_PATH), 'wanted-tracks.txt');
let wantedTracksRefreshChain = Promise.resolve();

function getWantedTracksSettings() {
    const rows = db.prepare(`SELECT key, value FROM scan_settings
        WHERE key IN ('wanted_tracks_mode', 'wanted_tracks_post_url', 'wanted_tracks_last_generated_at', 'wanted_tracks_last_result', 'wanted_tracks_last_count')`).all();
    const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
    const validModes = new Set(['file', 'post', 'both']);
    return {
        mode: validModes.has(values.wanted_tracks_mode) ? values.wanted_tracks_mode : 'file',
        post_url: String(values.wanted_tracks_post_url || ''),
        file_path: displayFilesystemPath(WANTED_TRACKS_FILE),
        last_generated_at: values.wanted_tracks_last_generated_at || '',
        last_result: values.wanted_tracks_last_result || '',
        last_count: Number.parseInt(values.wanted_tracks_last_count, 10) || 0
    };
}

function saveWantedTracksSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO scan_settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''));
}

function getCatalogArtistNames() {
    const artists = db.prepare(`SELECT DISTINCT artist FROM catalog
        WHERE artist IS NOT NULL AND TRIM(artist) <> ''`).all()
        .map(row => String(row.artist || '').trim())
        .filter(Boolean);
    return [...new Set(artists)].sort((a, b) => b.length - a.length);
}

function formatWantedTrackLine(value, catalogArtists = []) {
    const query = String(value || '').replace(/\s+/g, ' ').trim();
    if (!query) return null;

    const explicitPair = query.match(/^(.*?)\s+[-–—]\s+(.+)$/u);
    if (explicitPair) {
        const artist = explicitPair[1].trim();
        const title = explicitPair[2].trim();
        return artist && title ? `${artist} - ${title}` : null;
    }

    const lowerQuery = query.toLocaleLowerCase();
    const artist = catalogArtists.find(candidate =>
        lowerQuery.startsWith(`${candidate.toLocaleLowerCase()} `)
    );
    if (!artist) return null;

    const title = query.slice(artist.length).trim();
    return artist && title ? `${artist} - ${title}` : null;
}

function normalizeWantedTrackSnapshot(lines) {
    const catalogArtists = getCatalogArtistNames();
    const output = [];
    const seen = new Set();
    let skipped = 0;
    for (const value of lines) {
        const line = formatWantedTrackLine(value, catalogArtists);
        if (!line) {
            skipped++;
            continue;
        }
        const key = normalizeTextPlaylistQuery(line);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        output.push(line);
    }
    output.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return { lines: output, skipped };
}

let wantedTracksSnapshotBuildRunning = false;
let wantedTracksSnapshotBuildError = '';
let lastWantedTracksUnformattedCount = 0;

function readWantedTrackSnapshot() {
    const cached = db.prepare("SELECT value FROM scan_settings WHERE key = 'wanted_tracks_last_lines'").get();
    if (cached) {
        try {
            const parsed = JSON.parse(cached.value);
            if (Array.isArray(parsed) && parsed.every(line => typeof line === 'string')) {
                const normalized = normalizeWantedTrackSnapshot(parsed);
                lastWantedTracksUnformattedCount = normalized.skipped;
                const serialized = JSON.stringify(normalized.lines);
                if (cached.value !== serialized) saveWantedTracksSetting('wanted_tracks_last_lines', serialized);
                return normalized.lines;
            }
        } catch (_) {}
    }

    try {
        if (fs.existsSync(WANTED_TRACKS_FILE)) {
            const content = fs.readFileSync(WANTED_TRACKS_FILE, 'utf8');
            const lines = content.split(/\r?\n/).filter(line => line.trim());
            const normalized = normalizeWantedTrackSnapshot(lines);
            lastWantedTracksUnformattedCount = normalized.skipped;
            saveWantedTracksSetting('wanted_tracks_last_lines', JSON.stringify(normalized.lines));
            return normalized.lines;
        }
    } catch (error) {
        console.warn(`[Wanted Tracks] Could not read the existing wanted-tracks.txt snapshot: ${error.message}`);
    }
    return null;
}

function getCurrentWantedTrackLines() {
    const snapshot = readWantedTrackSnapshot();
    if (snapshot !== null) return snapshot;
    const lines = getWantedTrackLines();
    saveWantedTracksSetting('wanted_tracks_last_lines', JSON.stringify(lines));
    wantedTracksSnapshotBuildError = '';
    return lines;
}

function queueWantedTracksSnapshotBuild() {
    if (wantedTracksSnapshotBuildRunning || wantedTracksSnapshotBuildError) return;
    wantedTracksSnapshotBuildRunning = true;

    setTimeout(() => {
        try {
            if (readWantedTrackSnapshot() === null) {
                const lines = getWantedTrackLines();
                saveWantedTracksSetting('wanted_tracks_last_lines', JSON.stringify(lines));
            }
            wantedTracksSnapshotBuildError = '';
        } catch (error) {
            wantedTracksSnapshotBuildError = error.message || 'Could not build the current wanted list.';
            console.warn(`[Wanted Tracks] Could not build the initial wanted-list snapshot: ${wantedTracksSnapshotBuildError}`);
        } finally {
            wantedTracksSnapshotBuildRunning = false;
        }
    }, 100);
}
function validateWantedTracksPostUrl(value, required = false) {
    const raw = String(value || '').trim();
    if (!raw) {
        if (required) throw new Error('Enter the POST URL when POST delivery is enabled.');
        return '';
    }
    if (raw.length > 2048) throw new Error('The POST URL cannot exceed 2,048 characters.');
    let parsed;
    try { parsed = new URL(raw); }
    catch (_) { throw new Error('Enter a valid absolute HTTP or HTTPS POST URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
        throw new Error('The POST URL must use HTTP or HTTPS.');
    }
    if (parsed.username || parsed.password) {
        throw new Error('Do not embed a username or password in the POST URL.');
    }
    return parsed.toString();
}

function getWantedTrackLines() {

    const logs = db.prepare(`SELECT query, normalized_query FROM missing_track_logs
        WHERE query IS NOT NULL AND TRIM(query) <> '' ORDER BY id DESC`).all();
    const catalogRows = db.prepare(`SELECT search_str, artist FROM catalog
        WHERE search_str IS NOT NULL AND TRIM(search_str) <> ''`).all();
    const catalogArtists = getCatalogArtistNames();
    const uniqueQueries = new Map();
    for (const row of logs) {
        const query = String(row.query || '').trim();
        const key = normalizeTextPlaylistQuery(query || row.normalized_query || '');
        if (key && !uniqueQueries.has(key)) uniqueQueries.set(key, query);
    }
    if (!uniqueQueries.size) {
        lastWantedTracksUnformattedCount = 0;
        return [];
    }

    const catalogKeys = [...new Set(catalogRows.map(row => String(row.search_str || '').replace(/[^\w\s]/g, ' ').trim().toLowerCase()).filter(Boolean))];
    const lines = [];
    const seenLines = new Set();
    let skippedUnformatted = 0;
    for (const [key, query] of uniqueQueries) {
        const outputLine = formatWantedTrackLine(query, catalogArtists);
        if (!outputLine) {
            skippedUnformatted++;
            continue;
        }
        const outputKey = normalizeTextPlaylistQuery(outputLine);
        if (!outputKey || seenLines.has(outputKey)) continue;
        seenLines.add(outputKey);

        const cleanQuery = outputLine.replace(/\s+-\s+/u, ' ').replace(/[^\w\s]/g, ' ').trim().toLowerCase();
        let foundInPool = false;
        if (cleanQuery && catalogKeys.length) {
            const match = fuzz.extract(cleanQuery, catalogKeys, {
                scorer: fuzz.token_set_ratio,
                returnObjects: true,
                limit: 1
            })[0];
            foundInPool = !!(match && match.score >= 80);
        }
        if (!foundInPool) lines.push({ key: outputKey || key, line: outputLine });
    }

    lines.sort((a, b) => a.line.localeCompare(b.line, undefined, { sensitivity: 'base' }));
    lastWantedTracksUnformattedCount = skippedUnformatted;
    return lines.map(item => item.line);
}
function wantedTracksModeIncludesFile(mode) {
    return mode === 'file' || mode === 'both';
}

function wantedTracksModeIncludesPost(mode) {
    return mode === 'post' || mode === 'both';
}

async function generateAndDeliverWantedTracks(reason = 'manual generation') {
    const settings = getWantedTracksSettings();
    const lines = getWantedTrackLines();

    saveWantedTracksSetting('wanted_tracks_last_lines', JSON.stringify(lines));
    wantedTracksSnapshotBuildError = '';
    const generatedAt = new Date().toISOString();
    const text = lines.length ? `${lines.join('\n')}\n` : '';
    const result = {
        success: true,
        reason,
        generatedAt,
        count: lines.length,
        skippedUnformattedCount: lastWantedTracksUnformattedCount,
        preview: lines.slice(0, 30),
        filePath: WANTED_TRACKS_FILE,
        fileSaved: false,
        postSent: false,
        postStatus: null,
        errors: []
    };

    if (wantedTracksModeIncludesFile(settings.mode)) {
        const tempPath = `${WANTED_TRACKS_FILE}.${process.pid}.${Date.now()}.tmp`;
        try {
            fs.mkdirSync(path.dirname(WANTED_TRACKS_FILE), { recursive: true });
            fs.writeFileSync(tempPath, text, 'utf8');
            fs.renameSync(tempPath, WANTED_TRACKS_FILE);
            result.fileSaved = true;
        } catch (error) {
            try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
            result.errors.push(`Could not write wanted-tracks.txt: ${error.message}`);
        }
    }

    if (wantedTracksModeIncludesPost(settings.mode)) {
        try {
            const postUrl = validateWantedTracksPostUrl(settings.post_url, true);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            try {
                const response = await fetch(postUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json, text/plain, */*' },

                    body: JSON.stringify({ songs: lines.join('\n') }),
                    signal: controller.signal
                });
                if (!response.ok) {
                    let detail = '';
                    try { detail = (await response.text()).trim().slice(0, 300); } catch (_) {}
                    throw new Error(`POST endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
                }
                result.postSent = true;
                result.postStatus = response.status;
            } finally {
                clearTimeout(timeout);
            }
        } catch (error) {
            result.errors.push(`POST delivery failed: ${error.name === 'AbortError' ? 'request timed out after 10 seconds' : error.message}`);
        }
    }

    result.success = result.errors.length === 0;
    const skippedMessage = result.skippedUnformattedCount
        ? ` Skipped ${result.skippedUnformattedCount} legacy unmatched entr${result.skippedUnformattedCount === 1 ? 'y' : 'ies'} because MILO could not identify both the artist and song title; re-sync the source playlist to refresh those entries.`
        : '';
    result.message = result.errors.length
        ? `Generated ${lines.length} unique wanted track(s), but ${result.errors.join(' ')}${skippedMessage}`
        : `Generated ${lines.length} unique wanted track(s)${result.fileSaved ? ' and updated the text file' : ''}${result.postSent ? ` and sent the POST request (HTTP ${result.postStatus})` : ''}.${skippedMessage}`;

    saveWantedTracksSetting('wanted_tracks_last_generated_at', generatedAt);
    saveWantedTracksSetting('wanted_tracks_last_count', lines.length);
    saveWantedTracksSetting('wanted_tracks_last_result', JSON.stringify({
        success: result.success,
        message: result.message,
        fileSaved: result.fileSaved,
        postSent: result.postSent,
        postStatus: result.postStatus,
        errors: result.errors
    }));
    return result;
}

function queueWantedTracksRefresh(reason) {
    wantedTracksRefreshChain = wantedTracksRefreshChain
        .catch(() => undefined)
        .then(() => generateAndDeliverWantedTracks(reason))
        .then(result => {
            if (!result.success) console.warn(`[Wanted Tracks] Automatic update failed (${reason}): ${result.message}`);
            else console.log(`[Wanted Tracks] Updated after ${reason}: ${result.count} unique wanted track(s).`);
            return result;
        })
        .catch(error => {
            console.warn(`[Wanted Tracks] Automatic update failed (${reason}): ${error.message}`);
        });
}

function normalizedTextTokenSet(value) {
    return normalizeTextPlaylistQuery(value).split(/\s+/).filter(Boolean).sort().join(' ');
}

function clearMissingTrackLogForQuery(userId, query) {
    const exactTokenSet = normalizedTextTokenSet(query);
    if (!exactTokenSet) return 0;
    const matches = db.prepare('SELECT id, query, normalized_query FROM missing_track_logs WHERE user_id = ?').all(Number(userId))
        .filter(row => normalizedTextTokenSet(row.normalized_query || row.query || '') === exactTokenSet)
        .map(row => Number(row.id));
    if (!matches.length) return 0;
    const remove = db.prepare('DELETE FROM missing_track_logs WHERE user_id = ? AND id = ?');
    const transaction = db.transaction(ids => ids.reduce((sum, id) => sum + remove.run(Number(userId), id).changes, 0));
    return transaction(matches);
}

function recordMissingLogHistory(userId, log, action, track = null, alreadyAssigned = false, details = '') {
    if (!log || !log.query) return 0;
    const result = historyDb.prepare(`INSERT INTO missing_log_history
        (user_id, log_id, query, source, action, track_id, track_title, track_artist, already_assigned, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(Number(userId), log.id == null ? null : Number(log.id), String(log.query), String(log.source || 'unknown'),
            String(action), track && track.id != null ? Number(track.id) : null,
            track ? String(track.title || '') : '', track ? String(track.artist || '') : '', alreadyAssigned ? 1 : 0, String(details || ''));
    return result.lastInsertRowid;
}

function restoreMissingLogFromHistory(row) {
    const normalizedQuery = normalizeTextPlaylistQuery(row.query);
    if (!normalizedQuery) throw new Error('This history entry does not contain a usable unmatched query.');
    const existing = db.prepare('SELECT id FROM missing_track_logs WHERE user_id = ? AND normalized_query = ?').get(Number(row.user_id), normalizedQuery);
    if (existing) throw new Error('This unmatched query is already back in the active log list.');

    db.prepare(`INSERT INTO missing_track_logs (user_id, query, source, normalized_query)
        VALUES (?, ?, 'history', ?)`).run(Number(row.user_id), String(row.query), normalizedQuery);
}

function parseTextPlaylistEntries(value) {
    const lines = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
    return lines.map(line => String(line || '').trim()).filter(Boolean).map(line => line.slice(0, 500)).slice(0, 10000);
}

function appendTextPlaylistEntries(userId, entries, source = 'manual') {
    const values = parseTextPlaylistEntries(entries);
    const insert = db.prepare(`
        INSERT OR IGNORE INTO user_text_playlist (user_id, query, normalized_query, source)
        VALUES (?, ?, ?, ?)
    `);
    let added = 0;
    const transaction = db.transaction((items) => {
        for (const query of items) {
            const normalizedQuery = normalizeTextPlaylistQuery(query);
            if (!normalizedQuery) continue;
            added += insert.run(Number(userId), query, normalizedQuery, source).changes;
        }
    });
    transaction(values);
    return { added, received: values.length };
}

function replaceTextPlaylist(userId, value) {
    const entries = parseTextPlaylistEntries(value);
    const normalized = new Set();
    const unique = entries.filter(query => {
        const key = normalizeTextPlaylistQuery(query);
        if (!key || normalized.has(key)) return false;
        normalized.add(key);
        return true;
    });
    const deleteExisting = db.prepare('DELETE FROM user_text_playlist WHERE user_id = ?');
    const insert = db.prepare(`
        INSERT INTO user_text_playlist (user_id, query, normalized_query, source)
        VALUES (?, ?, ?, 'manual')
    `);
    db.transaction(() => {
        deleteExisting.run(Number(userId));
        for (const query of unique) insert.run(Number(userId), query, normalizeTextPlaylistQuery(query));
    })();
    return unique.length;
}

function getTextPlaylistEntries(userId) {
    return db.prepare(`SELECT id, query, source, created_at, updated_at
        FROM user_text_playlist WHERE user_id = ? ORDER BY id ASC`).all(Number(userId));
}

function getTextPlaylistQueries(userId) {
    return getTextPlaylistEntries(userId).map(item => item.query);
}

function getUserByTextPlaylistApiKey(key) {
    if (!key || typeof key !== 'string' || key.length > 256) return null;
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    return db.prepare('SELECT id FROM users WHERE text_playlist_api_key_hash = ?').get(hash) || null;
}

function getScanSettingsForOrganizer() {
    const rows = db.prepare("SELECT key, value FROM scan_settings").all();
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    if (settings.dump_folders) {
        try { settings.dump_folders = JSON.parse(settings.dump_folders); }
        catch (e) { settings.dump_folders = []; }
    } else {
        settings.dump_folders = settings.dump_folder && settings.dump_folder.trim()
            ? [{ path: settings.dump_folder.trim(), user_id: null }]
            : [];
    }
    if (settings.exempt_folders) {
        try { settings.exempt_folders = JSON.parse(settings.exempt_folders); }
        catch (e) { settings.exempt_folders = []; }
    } else {
        settings.exempt_folders = [];
    }
    return settings;
}

function catalogSearchString(artist, title) {
    return `${artist || ''} ${title || ''}`.replace(/[^\w\s]/g, ' ').trim().toLowerCase();
}

function upsertCatalogTrack(filePath, tags = {}) {
    filePath = normalizeFilesystemPath(filePath);
    if (!filePath || !fs.existsSync(filePath)) return;
    let previous = db.prepare('SELECT id, file_path, title, artist, album FROM catalog WHERE file_path = ?').get(filePath);

    if (!previous) {
        const key = normalizedPathKey(filePath);
        previous = db.prepare('SELECT id, file_path, title, artist, album FROM catalog').all()
            .find(row => normalizedPathKey(row.file_path) === key) || null;
    }
    const title = String(tags.title || (previous && previous.title) || path.parse(filePath).name || 'Unknown');
    const artist = String(tags.artist || tags.albumartist || (previous && previous.artist) || 'Unknown');
    const album = String(tags.album || (previous && previous.album) || 'Unknown');
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs / 1000; } catch (e) {}
    if (previous) {
        db.prepare(`UPDATE catalog SET file_path = ?, title = ?, artist = ?, album = ?, search_str = ?, added_at = ? WHERE id = ?`)
            .run(filePath, title, artist, album, catalogSearchString(artist, title), mtime, previous.id);
    } else {
        db.prepare(`INSERT INTO catalog (file_path, title, artist, album, search_str, added_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(file_path) DO UPDATE SET
                title=excluded.title, artist=excluded.artist, album=excluded.album,
                search_str=excluded.search_str, added_at=excluded.added_at`)
            .run(filePath, title, artist, album, catalogSearchString(artist, title), mtime);
    }
}

function updateCatalogTrackPath(oldPath, newPath, tags = {}) {
    oldPath = normalizeFilesystemPath(oldPath);
    newPath = normalizeFilesystemPath(newPath);
    const findCatalogPath = candidate => db.prepare('SELECT id, file_path FROM catalog WHERE file_path = ?').get(candidate)
        || db.prepare('SELECT id, file_path FROM catalog').all().find(row => normalizedPathKey(row.file_path) === normalizedPathKey(candidate))
        || null;
    const oldTrack = findCatalogPath(oldPath);
    if (!oldTrack) return true;
    const destinationTrack = findCatalogPath(newPath);
    const oldPathsToReconcile = [...new Set([oldTrack.file_path, oldPath])];
    if (destinationTrack && Number(destinationTrack.id) !== Number(oldTrack.id)) {

        oldPathsToReconcile.push(newPath);
    }
    try {
        const stat = fs.existsSync(newPath) ? fs.statSync(newPath) : null;
        db.transaction(() => {
            if (destinationTrack && Number(destinationTrack.id) !== Number(oldTrack.id)) {
                db.prepare(`INSERT OR IGNORE INTO user_tracks (user_id, track_id) SELECT user_id, ? FROM user_tracks WHERE track_id = ?`)
                    .run(oldTrack.id, destinationTrack.id);
                db.prepare('DELETE FROM catalog WHERE id = ?').run(destinationTrack.id);
            }
            const current = db.prepare('SELECT title, artist, album, added_at FROM catalog WHERE id = ?').get(oldTrack.id);
            const title = String(tags.title || (current && current.title) || path.parse(newPath).name || 'Unknown');
            const artist = String(tags.artist || tags.albumartist || (current && current.artist) || 'Unknown');
            const album = String(tags.album || (current && current.album) || 'Unknown');
            const addedAt = stat ? stat.mtimeMs / 1000 : ((current && current.added_at) || 0);
            db.prepare('UPDATE catalog SET file_path = ?, title = ?, artist = ?, album = ?, search_str = ?, added_at = ? WHERE id = ?')
                .run(newPath, title, artist, album, catalogSearchString(artist, title), addedAt, oldTrack.id);
        })();

        try {
            reconcileUserLibraryLinksForCatalogTrack(oldTrack.id, oldPathsToReconcile, newPath);
        } catch (linkError) {
            console.warn(`[Library] Catalog path updated but one or more user links need repair (${oldPath} -> ${newPath}): ${linkError.message}`);
        }
        invalidateLiveCatalogSnapshot();
        invalidateDeadFileResultsCache();
        lastLibraryLinkReconcileAt.clear();
        return true;
    } catch (error) {
        console.warn(`[Organizer] Could not remap catalog path ${oldPath} to ${newPath}: ${error.message}`);
        return false;
    }
}

const organizer = new Organizer({
    dbPath: DB_PATH,
    poolDir: MASTER_POOL_DIR,
    getScanSettings: getScanSettingsForOrganizer,
    onCatalogPathChanged: updateCatalogTrackPath,
    onPoolFileAdded: (filePath, tags = {}, options = {}) => {
        upsertCatalogTrack(filePath, tags);

        const assignedUserId = Number.parseInt(options && options.assignedUserId, 10);
        if (!Number.isSafeInteger(assignedUserId) || assignedUserId <= 0) return;

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(assignedUserId);
        const track = db.prepare('SELECT id FROM catalog WHERE file_path = ?').get(normalizeFilesystemPath(filePath));
        if (!user || !track) {
            console.warn(`[Organizer] Could not assign dump-folder track ${filePath}: tagged user or catalog row was not found.`);
            return;
        }

        try {

            addTrackToUserLibrary(user, track.id);
        } catch (error) {

            console.warn(`[Organizer] Could not add dump-folder song to ${user.username}'s library (${filePath}): ${error.message}`);
        }
    }
});

function requireLogin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ success: false, message: "Unauthorized" });
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId);
    if (!user) {
        req.session.destroy();
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    req.user = user;
    next();
}

function requireTextPlaylistApiKey(req, res, next) {
    const authorization = String(req.get('authorization') || '');
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    const key = req.get('x-milo-api-key') || (bearerMatch && bearerMatch[1]) || '';
    const user = getUserByTextPlaylistApiKey(key);
    if (!user) return res.status(401).json({ success: false, message: 'A valid MILO Text Playlist API key is required.' });
    req.apiUser = user;
    next();
}

function resolveDrivePoolPath(filePath) {
    if (!DRIVEPOOL_DRIVES.length || !filePath) return null;
    filePath = normalizeFilesystemPath(filePath);
    const parsed = path.parse(filePath);
    const relativePath = filePath.substring(parsed.root.length);

    for (const rawDrive of DRIVEPOOL_DRIVES) {
        const cleanDrive = String(rawDrive).replace(/\/+$/g, '');
        const driveRoot = `${cleanDrive}/`;
        try {
            if (!fs.existsSync(driveRoot)) continue;
            const entries = fs.readdirSync(driveRoot);
            const poolPart = entries.find(e => e.startsWith('PoolPart.'));

            if (poolPart) {
                const poolPartDir = normalizeFilesystemPath(driveRoot, poolPart);
                const physicalPath = normalizeFilesystemPath(poolPartDir, relativePath);
                if (fs.existsSync(physicalPath)) return { physicalPath, poolPartDir, relativePath };
            }
        } catch (e) {}
    }
    return null;
}

function removeExistingFileOrLink(filePath) {
    try {
        const resolved = normalizeFilesystemPath(filePath);
        const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
        if (fs.existsSync(resolved) || (stat && (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()))) {
            fs.rmSync(resolved, { recursive: true, force: true });
        }
    } catch (e) {}
}

function linkFile(sourcePath, targetPath, mode = 'standard') {
    sourcePath = normalizeFilesystemPath(sourcePath);
    targetPath = normalizeFilesystemPath(targetPath);
    if (!sourcePath || !targetPath) throw new Error('Source and destination paths are required to create a library link.');
    if (mode === 'advanced') {
        let actualSource = sourcePath;
        let actualTarget = targetPath;
        let activeDrivePoolDrive = null;

        if (DRIVEPOOL_DRIVES.length > 0) {
            const drivePoolSource = resolveDrivePoolPath(sourcePath);
            if (drivePoolSource) {
                actualSource = drivePoolSource.physicalPath;
                actualTarget = normalizeFilesystemPath(drivePoolSource.poolPartDir, targetPath.substring(path.parse(targetPath).root.length));
                activeDrivePoolDrive = drivePoolSource.poolPartDir;
            }
        }

        removeExistingFileOrLink(actualTarget);
        if (actualTarget !== targetPath) removeExistingFileOrLink(targetPath);
        fs.mkdirSync(path.dirname(actualTarget), { recursive: true });

        try {
            fs.linkSync(actualSource, actualTarget);
        } catch (err) {
            let reason = "The file system physically rejected the hard link.";
            if (err.code === 'ENOTSUP' || err.code === 'EXDEV' || err.code === 'EPERM') {
                if (activeDrivePoolDrive) reason = `DrivePool physical bypass failed on ${activeDrivePoolDrive}. Ensure target is NTFS.`;
                else reason = "Hard links are not supported on this virtual drive or network share.";
            }
            throw new Error(`${reason} (Raw Error: ${err.message})`);
        }
    } else {
        if (DRIVEPOOL_DRIVES.length > 0) {
            const drivePoolSource = resolveDrivePoolPath(sourcePath);
            if (drivePoolSource) {
                const targetParsed = path.parse(targetPath);
                const targetRelative = targetPath.substring(targetParsed.root.length);
                const physicalTarget = normalizeFilesystemPath(drivePoolSource.poolPartDir, targetRelative);
                removeExistingFileOrLink(physicalTarget);
            }
        }
        removeExistingFileOrLink(targetPath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        try {
            fs.symlinkSync(sourcePath, targetPath);
        } catch (err) {
            throw new Error(`Symbolic link creation failed: ${err.message}`);
        }
    }
}

function libraryLinkPathForPoolFile(libraryPath, poolFilePath) {
    const libraryRoot = resolveUserLibraryPath(libraryPath);
    const sourcePath = normalizeFilesystemPath(poolFilePath);
    if (!sourcePath) throw new Error('A source audio path is required to build its library link.');
    let relativePath = path.relative(normalizeFilesystemPath(MASTER_POOL_DIR), sourcePath);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        relativePath = path.basename(sourcePath);
    }
    let target = normalizeFilesystemPath(libraryRoot, relativePath);
    if (!pathSameOrInside(target, libraryRoot)) target = normalizeFilesystemPath(libraryRoot, path.basename(sourcePath));
    return target;
}

function pathEntryExists(filePath) {
    try { return !!fs.lstatSync(normalizeFilesystemPath(filePath), { throwIfNoEntry: false }); }
    catch (_) { return false; }
}

function isBrokenPoolSymlink(filePath) {
    try {
        const resolvedPath = normalizeFilesystemPath(filePath);
        const entry = fs.lstatSync(resolvedPath);
        if (!entry.isSymbolicLink() || fs.existsSync(resolvedPath)) return false;
        const rawTarget = fs.readlinkSync(resolvedPath);
        const linkTarget = normalizeFilesystemPath(path.dirname(resolvedPath), rawTarget);
        return pathSameOrInside(linkTarget, MASTER_POOL_DIR) && !fs.existsSync(linkTarget);
    } catch (_) {
        return false;
    }
}

function sameFileOnDisk(firstPath, secondPath) {
    try {
        firstPath = normalizeFilesystemPath(firstPath);
        secondPath = normalizeFilesystemPath(secondPath);
        const first = fs.statSync(firstPath);
        const second = fs.statSync(secondPath);
        if (!first.isFile() || !second.isFile()) return false;

        if (first.ino && second.ino) return first.dev === second.dev && first.ino === second.ino;
        const entry = fs.lstatSync(firstPath);
        if (entry.isSymbolicLink()) {
            const rawTarget = fs.readlinkSync(firstPath);
            const linkedTarget = normalizeFilesystemPath(path.dirname(firstPath), rawTarget);
            return normalizedPathKey(linkedTarget) === normalizedPathKey(secondPath);
        }
        return false;
    } catch (_) {
        return false;
    }
}

function normalizedPathKey(filePath) {
    const resolved = normalizeFilesystemPath(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function addTrackToUserLibrary(user, trackId) {
    const id = Number.parseInt(trackId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A valid catalog track must be selected.');
    const track = db.prepare('SELECT id, file_path FROM catalog WHERE id = ?').get(id);
    if (!track) throw new Error('The selected track is no longer in the catalog. Refresh the catalog and try again.');
    if (!isLiveCatalogPoolPath(track.file_path)) {
        invalidateLiveCatalogSnapshot();
        throw new Error('The selected audio file is no longer available in the Master Pool. Run a scan and try again.');
    }

    const sourcePath = normalizeFilesystemPath(track.file_path);
    const libraryRoot = resolveUserLibraryPath(user);
    const linkPath = libraryLinkPathForPoolFile(libraryRoot, sourcePath);
    const assigned = !!db.prepare('SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?')
        .get(Number(user.id), id);
    let createdLink = false;

    fs.mkdirSync(libraryRoot, { recursive: true });
    if (pathEntryExists(linkPath) && !sameFileOnDisk(linkPath, sourcePath)) {
        if (isBrokenPoolSymlink(linkPath)) removeExistingFileOrLink(linkPath);
        else throw new Error(`MILO found a different file at the expected library path and left it untouched: ${linkPath}`);
    }

    if (!pathEntryExists(linkPath)) {
        linkFile(sourcePath, linkPath, user.index_mode || 'standard');
        createdLink = true;
    }
    if (!sameFileOnDisk(linkPath, sourcePath)) {
        if (createdLink) removeExistingFileOrLink(linkPath);
        throw new Error('MILO could not verify the library link after creating it. Check the library path and indexing mode.');
    }

    try {
        if (!assigned) {
            db.prepare('INSERT INTO user_tracks (user_id, track_id) VALUES (?, ?)').run(Number(user.id), id);
        }
        historyDb.prepare('DELETE FROM removed_history WHERE user_id = ? AND track_id = ?').run(Number(user.id), id);
    } catch (error) {
        if (createdLink && !assigned) removeExistingFileOrLink(linkPath);
        throw error;
    }
    return { added: !assigned, trackId: id, linkPath };
}

function removeTrackFromUserLibrary(user, trackId) {
    const id = Number.parseInt(trackId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A valid catalog track must be selected.');
    const track = db.prepare('SELECT id, file_path FROM catalog WHERE id = ?').get(id);
    const sourcePath = track ? normalizeFilesystemPath(track.file_path) : '';
    const linkPath = sourcePath ? libraryLinkPathForPoolFile(resolveUserLibraryPath(user), sourcePath) : '';
    const result = db.prepare('DELETE FROM user_tracks WHERE user_id = ? AND track_id = ?').run(Number(user.id), id);

    if (track && linkPath && pathEntryExists(linkPath)) {

        if (sameFileOnDisk(linkPath, sourcePath) || isBrokenPoolSymlink(linkPath)) {
            removeExistingFileOrLink(linkPath);
            let currentDir = path.dirname(linkPath);
            const libraryRoot = resolveUserLibraryPath(user);
            while (currentDir && normalizeFilesystemPath(currentDir) !== libraryRoot && pathSameOrInside(currentDir, libraryRoot)) {
                try { fs.rmdirSync(currentDir); currentDir = path.dirname(currentDir); }
                catch (_) { break; }
            }
        }
    }
    return { removed: result.changes > 0, trackId: id };
}

function reconcileOneUserLibraryLink(user, trackId, oldPoolPaths, newPoolPath) {
    if (!user || !user.library_path || !newPoolPath || !fs.existsSync(newPoolPath)) return false;
    const libraryRoot = resolveUserLibraryPath(user);
    const newLinkPath = libraryLinkPathForPoolFile(libraryRoot, newPoolPath);
    const oldLinkPaths = [...new Set((oldPoolPaths || []).filter(Boolean)
        .map(filePath => libraryLinkPathForPoolFile(libraryRoot, filePath)))];
    const oldLinkKeys = new Set(oldLinkPaths.map(normalizedPathKey));
    const newKey = normalizedPathKey(newLinkPath);
    const newPathIsManagedOldLocation = oldLinkKeys.has(newKey);
    const targetExists = pathEntryExists(newLinkPath);
    const targetAlreadyCorrect = targetExists && sameFileOnDisk(newLinkPath, newPoolPath);

    if (targetExists && !targetAlreadyCorrect && !newPathIsManagedOldLocation && !isBrokenPoolSymlink(newLinkPath)) {
        console.warn(`[Library] Not replacing an unrelated file at ${newLinkPath} while repairing track ${trackId}.`);
        return false;
    }

    for (const oldLinkPath of oldLinkPaths) {
        if (normalizedPathKey(oldLinkPath) === newKey) continue;
        removeExistingFileOrLink(oldLinkPath);
    }

    if (targetAlreadyCorrect) return true;
    if (pathEntryExists(newLinkPath)) removeExistingFileOrLink(newLinkPath);
    try {
        fs.mkdirSync(path.dirname(newLinkPath), { recursive: true });
        linkFile(newPoolPath, newLinkPath, user.index_mode || 'standard');
        if (!sameFileOnDisk(newLinkPath, newPoolPath)) {
            throw new Error('Created library link does not resolve to the current pool file.');
        }
        return true;
    } catch (error) {
        console.warn(`[Library] Could not refresh ${user.username || user.id} track link ${newLinkPath}: ${error.message}`);
        return false;
    }
}

function reconcileUserLibraryLinksForCatalogTrack(trackId, oldPoolPaths, newPoolPath, onlyUserId = null) {
    if (!newPoolPath || !fs.existsSync(newPoolPath)) return { updated: 0, skipped: 0 };
    const params = [Number(trackId)];
    let userFilter = '';
    if (onlyUserId !== null && onlyUserId !== undefined) {
        userFilter = ' AND u.id = ?';
        params.push(Number(onlyUserId));
    }
    const users = db.prepare(`
        SELECT DISTINCT u.id, u.username, u.library_path, u.index_mode
        FROM user_tracks ut JOIN users u ON u.id = ut.user_id
        WHERE ut.track_id = ?${userFilter}
    `).all(...params);
    let updated = 0;
    let skipped = 0;
    for (const user of users) {
        if (reconcileOneUserLibraryLink(user, trackId, oldPoolPaths, newPoolPath)) updated++;
        else skipped++;
    }
    return { updated, skipped };
}

function convertUserLinks(userId, newMode) {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!user) throw new Error("User not found");
    const oldMode = user.index_mode || 'standard';
    if (oldMode === newMode) return 0;

    const userTracks = db.prepare(`SELECT c.file_path FROM user_tracks ut JOIN catalog c ON ut.track_id = c.id WHERE ut.user_id = ?`).all(userId);
    let converted = 0;
    const processedTracks = [];

    try {
        for (const track of userTracks) {
            const sourcePath = normalizeFilesystemPath(track.file_path);
            if (sourcePath && fs.existsSync(sourcePath)) {
                let relPath = path.relative(normalizeFilesystemPath(MASTER_POOL_DIR), sourcePath);
                if (relPath.startsWith('..')) relPath = path.basename(sourcePath);
                const libraryRoot = resolveUserLibraryPath(user);
                let targetPath = normalizeFilesystemPath(libraryRoot, relPath);
                if (!pathSameOrInside(targetPath, libraryRoot)) {
                    targetPath = normalizeFilesystemPath(libraryRoot, path.basename(sourcePath));
                }
                linkFile(sourcePath, targetPath, newMode);
                processedTracks.push({ source: sourcePath, target: targetPath });
                converted++;
            }
        }
    } catch (e) {
        for (const item of processedTracks) {
            try { linkFile(item.source, item.target, oldMode); } catch (revertErr) {}
        }
        throw new Error(`Mode switch aborted: ${e.message}`);
    }
    db.prepare("UPDATE users SET index_mode = ? WHERE id = ?").run(newMode, userId);
    return converted;
}

async function extractTags(filepath) {
    const filename = path.basename(filepath);
    let title = path.parse(filename).name, artist = "Unknown", album = "Unknown";
    try {
        const extension = path.extname(filepath).slice(1).toLowerCase();
        const metadata = await mm.parseFile(filepath, { skipCovers: true, ...(['opus', 'ogg'].includes(extension) ? { duration: true } : {}) });
        if (metadata.common.title) title = metadata.common.title;
        if (metadata.common.artist) artist = metadata.common.artist;
        if (metadata.common.album) album = metadata.common.album;
    } catch (e) {}

    title = String(title);
    artist = String(artist);
    album = String(album);
    const cleanSearch = `${artist} ${title}`.replace(/[^\w\s]/g, ' ').trim().toLowerCase();
    return { title, artist, album, cleanSearch };
}

async function walkDir(dir, exemptPaths = [], onProgress = null, onDirectoryError = null) {
    const results = [];
    const stack = [normalizeFilesystemPath(dir)];
    const excluded = (candidate) => exemptPaths.some(root => pathSameOrInside(candidate, root));
    let visitedEntries = 0;

    while (stack.length) {
        const current = stack.pop();
        if (excluded(current)) continue;
        let entries;
        try { entries = await fs.promises.readdir(current, { withFileTypes: true }); }
        catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
                if (typeof onDirectoryError === 'function') {
                    try { onDirectoryError({ directory: normalizeFilesystemPath(current), error }); } catch (_) {}
                } else if (error.code !== 'EACCES') {
                    console.warn(`[Catalog] Could not read directory ${current}: ${error.message}`);
                }
            }
            continue;
        }

        for (const entry of entries) {
            const fullPath = normalizeFilesystemPath(current, entry.name);
            if (entry.isDirectory()) {
                if (!excluded(fullPath)) stack.push(fullPath);
            } else if ((entry.isFile() || entry.isSymbolicLink()) && /\.(mp3|flac|m4a|ogg|wav|opus|aac|wma|aiff|aif)$/i.test(entry.name)) {
                try {
                    const stat = entry.isSymbolicLink() ? await fs.promises.stat(fullPath) : null;
                    if (entry.isFile() || (stat && stat.isFile())) results.push(fullPath);
                } catch (_) {

                }
            }
            if (++visitedEntries % 200 === 0) {
                if (typeof onProgress === 'function') {
                    try { onProgress({ visitedEntries, discoveredAudioFiles: results.length, currentDirectory: current }); } catch (_) {}
                }
                await new Promise(resolve => setImmediate(resolve));
            }
        }
    }
    return results;
}

function getExemptPaths() {
    let exemptPaths = [];
    try {
        const exemptStr = db.prepare("SELECT value FROM scan_settings WHERE key = 'exempt_folders'").get()?.value;
        if (exemptStr) {
            const parsed = JSON.parse(exemptStr);
            if (Array.isArray(parsed)) exemptPaths.push(...parsed);
        }
    } catch (e) {}

    try {
        const dumpFoldersStr = db.prepare("SELECT value FROM scan_settings WHERE key = 'dump_folders'").get()?.value;
        if (dumpFoldersStr) {
            const dumpFolders = JSON.parse(dumpFoldersStr);
            if (Array.isArray(dumpFolders)) {
                for (const item of dumpFolders) {
                    const p = typeof item === 'string' ? item : item?.path;
                    if (p && !exemptPaths.includes(p)) exemptPaths.push(p);
                }
            }
        }
    } catch (e) {}

    try {
        const dumpFolder = db.prepare("SELECT value FROM scan_settings WHERE key = 'dump_folder'").get()?.value || '';
        if (dumpFolder && !exemptPaths.includes(dumpFolder)) {
            exemptPaths.push(dumpFolder);
        }
    } catch (e) {}

    try {
        const trashFolder = db.prepare("SELECT value FROM scan_settings WHERE key = 'trash_folder'").get()?.value || '';
        if (trashFolder && !exemptPaths.includes(trashFolder)) {
            exemptPaths.push(trashFolder);
        }
    } catch (e) {}

    return exemptPaths.map(p => {
        const normalized = String(p || '').trim().replace(/\\/g, '/');
        return path.isAbsolute(normalized) ? normalizeFilesystemPath(normalized) : normalizeFilesystemPath(MASTER_POOL_DIR, normalized);
    });
}

function normalizeCatalogValue(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
}

function pathSameOrInside(candidatePath, rootPath) {
    if (!candidatePath || !rootPath) return false;
    const candidate = normalizeFilesystemPath(candidatePath);
    const root = normalizeFilesystemPath(rootPath);
    if (!candidate || !root) return false;
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isLiveCatalogPoolPath(filePath, exemptPaths = getExemptPaths()) {
    const resolved = normalizeFilesystemPath(filePath);
    if (!resolved || !/\.(mp3|flac|m4a|ogg|wav|opus|aac|wma|aiff|aif)$/i.test(resolved)) return false;
    if (!pathSameOrInside(resolved, MASTER_POOL_DIR) || pathSameOrInside(MASTER_POOL_DIR, resolved)) return false;

    try { if (!fs.statSync(resolved).isFile()) return false; }
    catch (_) { return false; }
    return !exemptPaths.some(exempt => pathSameOrInside(resolved, exempt));
}

function countLiveCatalogPoolTracks() {
    const exemptPaths = getExemptPaths();
    return db.prepare('SELECT id, file_path FROM catalog').all()
        .filter(row => isLiveCatalogPoolPath(row.file_path, exemptPaths)).length;
}

let liveCatalogSnapshot = { createdAt: 0, key: '', rows: [], ids: new Set() };
function invalidateLiveCatalogSnapshot() {
    liveCatalogSnapshot = { createdAt: 0, key: '', rows: [], ids: new Set() };
}
function getLiveCatalogSnapshot(force = false) {
    const exemptPaths = getExemptPaths();
    const key = [MASTER_POOL_DIR, ...exemptPaths].map(p => { const value = normalizeFilesystemPath(p); return process.platform === 'win32' ? value.toLowerCase() : value; }).join('\n');
    if (!force && liveCatalogSnapshot.key === key && Date.now() - liveCatalogSnapshot.createdAt < 5000) return liveCatalogSnapshot;
    const rows = db.prepare('SELECT id, file_path FROM catalog').all()
        .filter(row => isLiveCatalogPoolPath(row.file_path, exemptPaths));

    db.exec('CREATE TEMP TABLE IF NOT EXISTS live_catalog_ids (id INTEGER PRIMARY KEY)');
    const replaceIds = db.transaction(ids => {
        db.prepare('DELETE FROM live_catalog_ids').run();
        const insert = db.prepare('INSERT INTO live_catalog_ids (id) VALUES (?)');
        for (const id of ids) insert.run(id);
    });
    replaceIds(rows.map(row => row.id));
    liveCatalogSnapshot = { createdAt: Date.now(), key, rows, ids: new Set(rows.map(row => row.id)) };
    return liveCatalogSnapshot;
}

function mergeCatalogPathAliases(actualPoolFiles) {

    const pathKey = value => {
        const resolved = normalizeFilesystemPath(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const actualPaths = new Map(actualPoolFiles.map(filePath => [pathKey(filePath), normalizeFilesystemPath(filePath)]));
    const groups = new Map();
    for (const row of db.prepare('SELECT id, file_path FROM catalog').all()) {
        const key = pathKey(row.file_path);
        if (!actualPaths.has(key)) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    let merged = 0;
    for (const [key, group] of groups) {
        if (group.length < 2) {
            if (group.length === 1 && group[0].file_path !== actualPaths.get(key)) {
                db.prepare('UPDATE catalog SET file_path = ? WHERE id = ?').run(actualPaths.get(key), group[0].id);
            }
            continue;
        }
        const canonicalPath = actualPaths.get(key);
        const keeper = group.find(row => normalizeFilesystemPath(row.file_path) === canonicalPath) || [...group].sort((a, b) => a.id - b.id)[0];
        const duplicates = group.filter(row => row.id !== keeper.id);
        db.transaction(() => {
            for (const duplicate of duplicates) {
                db.prepare(`INSERT OR IGNORE INTO user_tracks (user_id, track_id) SELECT user_id, ? FROM user_tracks WHERE track_id = ?`)
                    .run(keeper.id, duplicate.id);
                db.prepare('DELETE FROM catalog WHERE id = ?').run(duplicate.id);
            }
            db.prepare('UPDATE catalog SET file_path = ? WHERE id = ?').run(canonicalPath, keeper.id);
        })();
        merged += duplicates.length;
    }
    return merged;
}

async function getLiveCatalogEmbeddedRows() {
    const exemptPaths = getExemptPaths();
    const rows = db.prepare('SELECT id, file_path, title, artist, album, search_str, added_at FROM catalog').all();
    const live = rows.filter(row => isLiveCatalogPoolPath(row.file_path, exemptPaths));
    const metadataCache = new Map();
    for (const row of live) {
        try {
            let tags = metadataCache.get(normalizeFilesystemPath(row.file_path));
            if (!tags) {
                tags = await organizer.getEmbeddedMetadataForPath(row.file_path);
                metadataCache.set(normalizeFilesystemPath(row.file_path), tags || {});
            }
            row.embedded = tags || {};
            row.quality = organizer.qualityProfile(row.file_path, row.embedded);
        } catch (_) { row.embedded = {}; row.quality = organizer.qualityProfile(row.file_path, {}); }
    }
    return { live, metadataCache, exemptPaths };
}

function deadTrackIdentity(value) {
    const full = normalizeCatalogValue(value);

    const primary = full.replace(/\b(?:feat|featuring|ft)\b.*$/, '').trim();
    return { full, primary };
}

function deadTrackTextMatches(first, second) {
    const a = deadTrackIdentity(first);
    const b = deadTrackIdentity(second);
    if (!a.full || !b.full) return false;
    return a.full === b.full || (!!a.primary && a.primary === b.primary);
}

function deadArtistMatches(deadArtist, candidateTags) {
    const oldCredits = [deadArtist].filter(Boolean);
    const currentCredits = [candidateTags.artist, candidateTags.albumartist].filter(Boolean);
    return oldCredits.some(oldValue => currentCredits.some(currentValue => deadTrackTextMatches(oldValue, currentValue)));
}

function deadTitleIndexKeys(value) {
    const identity = deadTrackIdentity(value);
    return [...new Set([identity.full, identity.primary].filter(Boolean))];
}

function buildDeadCandidateTitleIndex(liveRows) {
    const index = new Map();
    for (const candidate of liveRows) {
        const title = candidate.embedded && candidate.embedded.title;
        if (!title) continue;
        for (const key of deadTitleIndexKeys(title)) {
            if (!index.has(key)) index.set(key, []);
            index.get(key).push(candidate);
        }
    }
    return index;
}

function removeDeadCandidateFromTitleIndex(index, candidate) {
    const title = candidate.embedded && candidate.embedded.title;
    if (!title) return;
    for (const key of deadTitleIndexKeys(title)) {
        const rows = index.get(key);
        if (!rows) continue;
        const next = rows.filter(row => row !== candidate);
        if (next.length) index.set(key, next);
        else index.delete(key);
    }
}

function deadRowMatchOptions(deadRow, liveRowsOrIndex, candidateExemptPaths = getExemptPaths()) {
    const deadIdentity = deadTrackIdentity(deadRow.title);
    const deadTitle = deadIdentity.full;
    const deadArtist = normalizeCatalogValue(deadRow.artist);
    const deadAlbum = normalizeCatalogValue(deadRow.album);
    if (!deadTitle || !deadArtist || deadArtist === 'unknown') return [];

    let candidates;
    if (liveRowsOrIndex instanceof Map) {
        const found = new Set();
        for (const key of [deadIdentity.full, deadIdentity.primary].filter(Boolean)) {
            for (const candidate of (liveRowsOrIndex.get(key) || [])) found.add(candidate);
        }
        candidates = [...found];
    } else {

        candidates = liveRowsOrIndex || [];
    }

    const deadPathKey = deadCandidatePathKey(deadRow.file_path);
    const deadFolderKey = deadCandidatePathKey(path.dirname(deadRow.file_path));
    return candidates.filter(candidate => {
        if ((candidate.id != null && Number(candidate.id) === Number(deadRow.id))
            || deadCandidatePathKey(candidate.file_path) === deadPathKey) return false;
        const tags = candidate.embedded || {};
        if (!tags.title || !deadTrackTextMatches(deadRow.title, tags.title)) return false;

        if (!isLiveCatalogPoolPath(candidate.file_path, candidateExemptPaths)) return false;
        if (!deadArtistMatches(deadRow.artist, tags)) return false;
        const album = normalizeCatalogValue(tags.album);

        candidate._albumMatches = !deadAlbum || deadAlbum === 'unknown' || (!!album && album === deadAlbum);
        candidate._albumDiffers = !!deadAlbum && deadAlbum !== 'unknown' && !!album && album !== deadAlbum;
        candidate._samePreviousFolder = deadCandidatePathKey(path.dirname(candidate.file_path)) === deadFolderKey;
        candidate._albumMissing = !!deadAlbum && deadAlbum !== 'unknown' && !album;
        return true;
    });
}

function chooseDeadRowReplacement(deadRow, matches) {
    if (!matches.length) return null;
    const exactAlbum = matches.filter(item => item._albumMatches);
    const albumPool = exactAlbum.length ? exactAlbum : matches;

    const sameFolder = albumPool.filter(item => item._samePreviousFolder);
    const pool = sameFolder.length ? sameFolder : albumPool;
    const ranked = [...pool].sort((a, b) => (b.quality?.tier || 0) - (a.quality?.tier || 0)
        || (b.quality?.bitsPerSample || 0) - (a.quality?.bitsPerSample || 0)
        || (b.quality?.bitrate || 0) - (a.quality?.bitrate || 0));
    const top = ranked[0];
    const sameRank = ranked.filter(item => (item.quality?.tier || 0) === (top.quality?.tier || 0)
        && (item.quality?.bitsPerSample || 0) === (top.quality?.bitsPerSample || 0)
        && (item.quality?.bitrate || 0) === (top.quality?.bitrate || 0));
    if (sameRank.length !== 1) return null;
    return { ...top, album_match: !!top._albumMatches, album_differs: !!top._albumDiffers, _albumMissing: !!top._albumMissing, format: top.quality?.extension ? String(top.quality.extension).toUpperCase() : path.extname(top.file_path).slice(1).toUpperCase() };
}

function deadCandidatePathKey(filePath) {
    const resolved = normalizeFilesystemPath(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function getDeadFileCandidateRows(deadRows = [], options = {}) {
    const exemptPaths = getExemptPaths();
    const byPath = new Map();
    const recordByPath = new Map();
    const wantedTitleKeys = new Set();
    for (const deadRow of deadRows) {
        for (const key of deadTitleIndexKeys(deadRow.title)) wantedTitleKeys.add(key);
    }
    if (!wantedTitleKeys.size) return [];

    const catalogByPath = new Map(db.prepare('SELECT id, file_path, title, artist, album, search_str, added_at FROM catalog')
        .all().map(row => [deadCandidatePathKey(row.file_path), row]));
    const fileRecords = organizer.db.prepare(`SELECT file_path, sha256, size, mtime_ms, metadata_json
        FROM file_records WHERE source_type = 'pool'`).all();

    const makeCandidate = (filePath, embedded, catalogRow = null, record = null) => ({
        ...(catalogRow || {}), file_path: normalizeFilesystemPath(filePath),
        title: String((embedded && embedded.title) || (catalogRow && catalogRow.title) || path.parse(filePath).name),
        artist: String((embedded && (embedded.artist || embedded.albumartist)) || (catalogRow && catalogRow.artist) || ''),
        album: String((embedded && embedded.album) || (catalogRow && catalogRow.album) || ''),
        added_at: Number(catalogRow && catalogRow.added_at) || 0,
        embedded: embedded || {}, quality: organizer.qualityProfile(filePath, embedded || {}),
        sha256: record && record.sha256
    });

    for (let i = 0; i < fileRecords.length; i++) {
        const record = fileRecords[i];
        const filePath = normalizeFilesystemPath(record.file_path);
        if (!Organizer.pathIsInside(filePath, MASTER_POOL_DIR)
            || !/\.(mp3|flac|m4a|ogg|wav|opus|aac|wma|aiff|aif)$/i.test(filePath)
            || exemptPaths.some(exempt => pathSameOrInside(filePath, exempt))) continue;
        const embedded = organizer.safeJson(record.metadata_json, {});
        if (!embedded.title || !deadTitleIndexKeys(embedded.title).some(key => wantedTitleKeys.has(key))) continue;
        const key = deadCandidatePathKey(filePath);
        if (byPath.has(key)) continue;
        byPath.set(key, makeCandidate(filePath, embedded, catalogByPath.get(key) || null, record));
        recordByPath.set(key, record);
        if (i % 1000 === 0) await new Promise(resolve => setImmediate(resolve));
    }

    if (options.discoverNearby !== false) {
        const folders = new Map();
        const poolKey = deadCandidatePathKey(MASTER_POOL_DIR);
        for (const deadRow of deadRows) {
            const folder = normalizeFilesystemPath(path.dirname(normalizeFilesystemPath(deadRow.file_path || '')));
            const folderKey = deadCandidatePathKey(folder);
            if (folders.has(folderKey) || folderKey === poolKey || !pathSameOrInside(folder, MASTER_POOL_DIR)) continue;
            if (exemptPaths.some(exempt => pathSameOrInside(folder, exempt)) || !fs.existsSync(folder)) continue;
            folders.set(folderKey, folder);
        }
        for (const folder of folders.values()) {
            const diskPaths = await walkDir(folder, exemptPaths);
            for (let i = 0; i < diskPaths.length; i++) {
                const filePath = normalizeFilesystemPath(diskPaths[i]);
                const key = deadCandidatePathKey(filePath);
                const indexed = recordByPath.get(key) || null;
                if (byPath.has(key) && indexed) {

                    let stat = null;
                    try { stat = await fs.promises.stat(filePath); } catch (_) { continue; }
                    if (Number(indexed.size) === stat.size && Math.abs(Number(indexed.mtime_ms || 0) - stat.mtimeMs) < 1) continue;
                    let embedded = {};
                    try { embedded = await organizer.readTags(filePath); } catch (_) { continue; }
                    if (!embedded.title || !(embedded.artist || embedded.albumartist)
                        || !deadTitleIndexKeys(embedded.title).some(titleKey => wantedTitleKeys.has(titleKey))) {
                        byPath.delete(key);
                        recordByPath.delete(key);
                        continue;
                    }
                    const row = catalogByPath.get(key) || null;
                    byPath.set(key, makeCandidate(filePath, embedded, row, { ...indexed, size: stat.size, mtime_ms: stat.mtimeMs }));
                    recordByPath.set(key, { ...indexed, size: stat.size, mtime_ms: stat.mtimeMs, metadata_json: JSON.stringify(embedded) });
                    continue;
                }
                if (byPath.has(key)) continue;
                let embedded = {};
                try { embedded = await organizer.readTags(filePath); } catch (_) {}
                if (!embedded.title || !(embedded.artist || embedded.albumartist)
                    || !deadTitleIndexKeys(embedded.title).some(titleKey => wantedTitleKeys.has(titleKey))) continue;
                const row = catalogByPath.get(key) || null;
                byPath.set(key, makeCandidate(filePath, embedded, row, null));
                if (i % 25 === 0) await new Promise(resolve => setImmediate(resolve));
            }
        }
    }
    return [...byPath.values()];
}

async function findMissingCatalogRows(rows, exemptPaths = getExemptPaths(), onProgress = null) {

    const folders = new Map();
    for (const row of rows) {
        if (!Organizer.pathIsInside(row.file_path, MASTER_POOL_DIR)
            || exemptPaths.some(exempt => pathSameOrInside(row.file_path, exempt))) continue;
        const directory = normalizeFilesystemPath(path.dirname(normalizeFilesystemPath(row.file_path)));
        const key = deadCandidatePathKey(directory);
        if (!folders.has(key)) folders.set(key, { directory, rows: [] });
        folders.get(key).rows.push(row);
    }

    const groups = [...folders.values()];
    const missing = [];
    const concurrency = 16;
    const filenameKey = value => process.platform === 'win32' ? String(value).toLowerCase() : String(value);
    for (let offset = 0; offset < groups.length; offset += concurrency) {
        const chunk = groups.slice(offset, offset + concurrency);
        const results = await Promise.all(chunk.map(async group => {
            try {
                const entries = await fs.promises.readdir(group.directory, { withFileTypes: true });
                const presentNames = new Set(entries
                    .filter(entry => !entry.isDirectory() && /\.(mp3|flac|m4a|ogg|wav|opus|aac|wma|aiff|aif)$/i.test(entry.name))
                    .map(entry => filenameKey(entry.name)));
                return group.rows.filter(row => !presentNames.has(filenameKey(path.basename(row.file_path))));
            } catch (error) {

                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return group.rows;
                console.warn(`[Dead Files] Could not inspect directory ${group.directory}; leaving its catalog entries unclassified: ${error.message}`);
                return [];
            }
        }));
        for (const groupMissing of results) missing.push(...groupMissing);
        if (typeof onProgress === 'function') {
            onProgress(Math.min(offset + chunk.length, groups.length), groups.length);
        }
        await new Promise(resolve => setImmediate(resolve));
    }
    return missing;
}

let deadFileResultsCache = { createdAt: 0, rows: null };
let deadFileResultsPromise = null;
function invalidateDeadFileResultsCache() {
    deadFileResultsCache = { createdAt: 0, rows: null };
}

async function getDeadFileRowsWithSuggestions() {
    if (deadFileResultsCache.rows && Date.now() - deadFileResultsCache.createdAt < 15000) {
        return deadFileResultsCache.rows;
    }
    if (deadFileResultsPromise) return deadFileResultsPromise;
    deadFileResultsPromise = (async () => {
        if (!fs.existsSync(MASTER_POOL_DIR)) throw new Error('The master pool is unavailable. Verify the configured pool path or mounted drive, then try again.');
        const exemptPaths = getExemptPaths();
        const rows = db.prepare('SELECT id, file_path, title, artist, album, search_str, added_at FROM catalog').all();
        const deadRows = await findMissingCatalogRows(rows, exemptPaths);
        if (!deadRows.length) return [];
        const live = await getDeadFileCandidateRows(deadRows);
        const candidateIndex = buildDeadCandidateTitleIndex(live);
        return deadRows.map(row => {
            const matches = deadRowMatchOptions(row, candidateIndex, exemptPaths);
            const replacement = chooseDeadRowReplacement(row, matches);
            const missingExtension = path.extname(row.file_path).slice(1).toLowerCase();
            const replacementIsUpgrade = !!(replacement && replacement.album_match && organizer.isBetterQualityVersion(
                replacement.file_path, replacement.embedded || {}, row.file_path, { _extension: missingExtension }
            ));
            return {
                id: row.id, title: row.title, artist: row.artist, album: row.album, path: row.file_path,
                missing_format: missingExtension.toUpperCase(),
                replacement: replacement ? {
                    path: replacement.file_path, title: replacement.embedded?.title || replacement.title,
                    artist: replacement.embedded?.artist || replacement.embedded?.albumartist || replacement.artist,
                    album: replacement.embedded?.album || replacement.album, format: replacement.format,
                    duration: replacement.embedded?.duration || '', bitrate: replacement.embedded?._bitrate || '',
                    bit_depth: replacement.embedded?._bits_per_sample || replacement.embedded?._bit_depth || '',
                    album_match: replacement.album_match, is_higher_quality: replacementIsUpgrade,
                    message: replacementIsUpgrade
                        ? `${replacement.format} is a higher-priority format than the missing ${missingExtension.toUpperCase() || 'audio'} file. Repairing the path preserves the existing catalog identity and library assignments.`
                        : (replacement.album_match
                            ? 'Embedded title, artist, and compatible album metadata support this path repair.'
                            : (replacement._albumMissing
                                ? 'Title and artist match, but the existing file has no embedded album tag. Review carefully; it will not be repaired automatically.'
                                : 'Title and artist match, but the album differs. Review carefully before repairing.'))
                } : null,
                ambiguous_matches: matches.length > 1 && !replacement
            };
        });
    })();
    try {
        const result = await deadFileResultsPromise;
        deadFileResultsCache = { createdAt: Date.now(), rows: result };
        return result;
    } finally {
        deadFileResultsPromise = null;
    }
}

async function runDeadFileRepairJob(items) {
    const results = [];
    try {
        activeDeadFileJob.message = `Preparing replacement matches for ${items.length} selected catalog entr${items.length === 1 ? 'y' : 'ies'}...`;
        activeDeadFileJob.progress = 0;
        activeDeadFileJob.total = items.length;

        const selectedIds = [...new Set(items.map(item => Number(item.id)))];
        const placeholders = selectedIds.map(() => '?').join(',');
        const rows = selectedIds.length
            ? db.prepare(`SELECT id, file_path, title, artist, album FROM catalog WHERE id IN (${placeholders})`).all(...selectedIds)
            : [];
        const rowsById = new Map(rows.map(row => [Number(row.id), row]));
        const deadRows = rows.filter(row => !fs.existsSync(row.file_path));
        const exemptPaths = getExemptPaths();
        const liveCandidates = await getDeadFileCandidateRows(deadRows);
        const candidateIndex = buildDeadCandidateTitleIndex(liveCandidates);
        const usedReplacementPaths = new Set();

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const id = Number(item.id);
            const replacementPath = normalizeFilesystemPath(String(item.replacement_path || ''));
            const deadRow = rowsById.get(id);
            activeDeadFileJob.message = `Repairing selected catalog entries: ${i + 1} / ${items.length}`;
            try {
                if (!deadRow) throw new Error('The catalog entry no longer exists. Refresh Dead Files and try again.');
                if (fs.existsSync(deadRow.file_path)) throw new Error('The original file is available again; this entry is no longer a dead file.');
                if (!isLiveCatalogPoolPath(replacementPath, exemptPaths)) {
                    throw new Error('The selected replacement is no longer an eligible audio file in the Master Pool.');
                }
                const replacementKey = deadCandidatePathKey(replacementPath);
                if (usedReplacementPaths.has(replacementKey)) {
                    throw new Error('This replacement was already selected for another catalog entry in the same batch.');
                }
                const matches = deadRowMatchOptions(deadRow, candidateIndex, exemptPaths);
                const replacement = matches.find(candidate => deadCandidatePathKey(candidate.file_path) === replacementKey);
                if (!replacement) throw new Error('The replacement no longer has matching embedded title and artist metadata.');
                if (!updateCatalogTrackPath(deadRow.file_path, replacementPath, replacement.embedded || {})) {
                    throw new Error('The catalog path could not be updated; the entry was left unchanged.');
                }
                usedReplacementPaths.add(replacementKey);
                try { await organizer.removeDeadFileRecord(deadRow.file_path); }
                catch (cleanupError) { console.warn(`[Dead Files] Could not remove stale organizer identity ${deadRow.file_path}: ${cleanupError.message}`); }
                results.push({ id, success: true, message: `Repaired ${deadRow.title || path.basename(deadRow.file_path)}.` });
            } catch (error) {
                results.push({ id, success: false, message: error.message });
            }
            activeDeadFileJob.progress = i + 1;
            if (i % 2 === 0) await new Promise(resolve => setImmediate(resolve));
        }

        const repaired = results.filter(result => result.success).length;
        const failed = results.length - repaired;
        invalidateDeadFileResultsCache();
        invalidateLiveCatalogSnapshot();
        lastLibraryLinkReconcileAt.clear();
        activeDeadFileJob = {
            ...activeDeadFileJob,
            status: 'completed', task: 'dead-files-repair', progress: items.length, total: items.length,
            message: `Catalog repair finished: ${repaired} repaired${failed ? `, ${failed} need attention` : ''}.`,
            result: { repaired, failed, items: results.slice(0, 100) },
            errorTrace: failed ? results.filter(item => !item.success).map(item => `Catalog entry ${item.id}: ${item.message}`).join('\n') : '',
            startedAt: activeDeadFileJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false
        };
        persistStandaloneTaskHistory(activeDeadFileJob);
    } catch (error) {
        activeDeadFileJob = {
            ...activeDeadFileJob,
            status: 'error', task: 'dead-files-repair', progress: activeDeadFileJob.progress || 0,
            total: items.length, message: error.message, errorTrace: error.stack || error.message,
            result: { repaired: 0, failed: items.length, items: results.slice(0, 100) },
            startedAt: activeDeadFileJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false
        };
        persistStandaloneTaskHistory(activeDeadFileJob);
    }
}

async function runDeadFilesPurgeJob() {
    try {
        if (!fs.existsSync(MASTER_POOL_DIR)) throw new Error('Master pool directory missing. Aborting purge.');
        const rows = db.prepare('SELECT id, file_path FROM catalog').all();
        activeDeadFileJob.progress = 0;
        activeDeadFileJob.total = rows.length;
        activeDeadFileJob.message = `Checking ${rows.length.toLocaleString()} catalog entries for missing paths...`;
        const deadRows = await findMissingCatalogRows(rows, getExemptPaths(), (progress, total) => {
            activeDeadFileJob.progress = progress;
            activeDeadFileJob.total = total;
            activeDeadFileJob.message = `Checking catalog folders: ${progress} / ${total}`;
        });

        activeDeadFileJob.progress = 0;
        activeDeadFileJob.total = deadRows.length;
        if (!deadRows.length) {
            activeDeadFileJob = { ...activeDeadFileJob, status: 'completed', task: 'dead-files-purge', progress: 0, total: 0,
                message: 'Purge complete: no stale catalog entries were found.', result: { purged: 0 }, startedAt: activeDeadFileJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false };
            persistStandaloneTaskHistory(activeDeadFileJob);
            return;
        }
        activeDeadFileJob.message = `Clearing ${deadRows.length.toLocaleString()} stale catalog entries...`;
        const deleteRows = db.prepare('DELETE FROM catalog WHERE id = ?');
        for (let i = 0; i < deadRows.length; i++) {
            deleteRows.run(deadRows[i].id);
            organizer.removeDeadFileRecord(deadRows[i].file_path).catch(error => {
                console.warn(`[Dead Files] Could not remove stale organizer identity ${deadRows[i].file_path}: ${error.message}`);
            });
            activeDeadFileJob.progress = i + 1;
            if (i % 100 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        invalidateDeadFileResultsCache();
        invalidateLiveCatalogSnapshot();
        lastLibraryLinkReconcileAt.clear();
        activeDeadFileJob = { ...activeDeadFileJob, status: 'completed', task: 'dead-files-purge', progress: deadRows.length, total: deadRows.length,
            message: `Purge complete: cleared ${deadRows.length.toLocaleString()} stale catalog entr${deadRows.length === 1 ? 'y' : 'ies'}. No audio files were deleted.`,
            result: { purged: deadRows.length }, startedAt: activeDeadFileJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false };
        persistStandaloneTaskHistory(activeDeadFileJob);
    } catch (error) {
        activeDeadFileJob = { ...activeDeadFileJob, status: 'error', task: 'dead-files-purge', progress: activeDeadFileJob.progress || 0,
            total: activeDeadFileJob.total || 0, message: error.message, errorTrace: error.stack || error.message, result: null, startedAt: activeDeadFileJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false };
        persistStandaloneTaskHistory(activeDeadFileJob);
    }
}

async function reconcileDeadCatalogPaths(scannedPoolPaths = null) {
    const catalogRows = db.prepare('SELECT id, file_path, title, artist, album FROM catalog').all();
    let rowsToCheck = catalogRows;
    if (Array.isArray(scannedPoolPaths)) {

        const scannedKeys = new Set(scannedPoolPaths.map(deadCandidatePathKey));
        rowsToCheck = catalogRows.filter(row => !scannedKeys.has(deadCandidatePathKey(row.file_path)));
    }
    const deadRows = await findMissingCatalogRows(rowsToCheck);
    if (!deadRows.length) return 0;

    const live = await getDeadFileCandidateRows(deadRows, { discoverNearby: false });
    const candidateIndex = buildDeadCandidateTitleIndex(live);
    const exemptPaths = getExemptPaths();
    let repaired = 0;
    for (const deadRow of deadRows) {
        const replacement = chooseDeadRowReplacement(deadRow, deadRowMatchOptions(deadRow, candidateIndex, exemptPaths));
        if (!replacement || !replacement.album_match) continue;
        const newPath = normalizeFilesystemPath(replacement.file_path);
        if (!isLiveCatalogPoolPath(newPath)) continue;
        try {
            const tags = replacement.embedded || {};
            if (!updateCatalogTrackPath(deadRow.file_path, newPath, tags)) {
                throw new Error('Catalog path update failed. The existing catalog entry was left unchanged.');
            }
            await organizer.removeDeadFileRecord(deadRow.file_path);
            const usedCandidate = live.find(item => deadCandidatePathKey(item.file_path) === deadCandidatePathKey(newPath));
            if (usedCandidate) removeDeadCandidateFromTitleIndex(candidateIndex, usedCandidate);
            repaired++;
        } catch (error) {
            console.warn(`[Organizer] Could not reconcile missing catalog path ${deadRow.file_path}: ${error.message}`);
        }
    }
    return repaired;
}

let activeScanJob = { status: 'idle', progress: 0, total: 0, message: '' };
let activeOrganizerJob = { status: 'idle', progress: 0, total: 0, message: '', result: null };
let activeDeadFileJob = { status: 'idle', task: '', progress: 0, total: 0, message: '', result: null };
const activeMissingLogJobs = new Map();
const activeRestoreJobs = new Map();
const lastLibraryLinkReconcileAt = new Map();

function safeProgressSnapshot(job, jobType) {
    if (!job || !job.status || job.status === 'idle' || job.dismissed) return null;
    const { passwordHash, newPath, newMode, newRole, targetUserId, ...safeJob } = job;
    return { ...safeJob, jobType };
}

app.get('/api/progress/current', requireLogin, (req, res) => {
    const candidates = [];
    const activeScanTask = req.user.role === 'admin' && activeScanJob.queueId
        ? queuedWorkTasks.get(activeScanJob.queueId) : null;
    const activeScanIsScheduled = activeScanTask
        ? !!activeScanTask.scheduled
        : String(activeScanJob.trigger || '').toLowerCase().includes('scheduled');
    const userImport = safeProgressSnapshot(activeJobs[req.user.id], 'import');
    if (userImport) candidates.push({
        ...userImport,
        ownedByViewer: true,
        createdAt: userImport.createdAt || userImport.startedAt || 0
    });
    const userMissing = safeProgressSnapshot(activeMissingLogJobs.get(req.user.id), 'missing-logs-bulk');
    if (userMissing) candidates.push(userMissing);
    const userRestore = safeProgressSnapshot(activeRestoreJobs.get(req.user.id), 'restore-tracks-bulk');
    if (userRestore) candidates.push(userRestore);

    if (req.user.role === 'admin') {

        const scan = activeScanIsScheduled ? null : safeProgressSnapshot(activeScanJob, 'scan');
        if (scan) {
            const scanTask = scan.queueId ? queuedWorkTasks.get(scan.queueId) : null;
            candidates.push({
                ...scan,
                scheduled: !!scanTask?.scheduled,
                ownedByViewer: !!(scanTask && scanTask.requestedByUserId === Number(req.user.id)),
                createdAt: scanTask?.createdAt || scan.createdAt || scan.startedAt || 0
            });
        }
        const organizerActive = activeOrganizerJob && ['running', 'fetching', 'processing'].includes(activeOrganizerJob.status);
        const organizerWasNestedInScan = !!(activeOrganizerJob && activeOrganizerJob.nestedInScan);
        const scanActive = activeScanJob && ['running', 'fetching', 'processing'].includes(activeScanJob.status);

        if (organizerActive && !scanActive && !organizerWasNestedInScan) {
            const organizerSnapshot = safeProgressSnapshot(activeOrganizerJob, activeOrganizerJob.task === 'bulk-review' ? 'bulk-review' : 'organizer');
            if (organizerSnapshot) candidates.push(organizerSnapshot);
        } else if (!scanActive && !organizerWasNestedInScan) {
            const organizerSnapshot = safeProgressSnapshot(activeOrganizerJob, activeOrganizerJob.task === 'bulk-review' ? 'bulk-review' : 'organizer');
            if (organizerSnapshot) candidates.push(organizerSnapshot);
        }
        const deadFiles = safeProgressSnapshot(activeDeadFileJob, 'dead-files-bulk');
        if (deadFiles) candidates.push(deadFiles);
        const libraryPath = safeProgressSnapshot(activeLibraryPathJob, 'library-path');
        if (libraryPath) candidates.push(libraryPath);
    }

    for (const queuedTask of queuedWorkTasks.values()) {
        if (queuedTask.status !== 'queued') continue;
        if (queuedTask.kind === 'scan' && queuedTask.scheduled) continue;
        const isOwner = queuedTask.requestedByUserId === Number(req.user.id);
        if (!isOwner && !(req.user.role === 'admin' && queuedTask.kind === 'scan')) continue;
        if (queuedTask.kind === 'scan') {
            candidates.push({
                status: 'queued', type: queuedTask.scanType, trigger: queuedTask.trigger,
                queueId: queuedTask.id, progress: 0, total: 0, message: queuedTask.message,
                startedAt: queuedTask.createdAt, createdAt: queuedTask.createdAt,
                ownedByViewer: isOwner, dismissed: false, jobType: 'scan'
            });
        }
    }

    const running = candidates.filter(job => ['running', 'fetching', 'processing'].includes(job.status));

    const viewerQueuedWork = candidates
        .filter(job => job.queueId && job.ownedByViewer && ['queued', 'running', 'fetching', 'processing'].includes(job.status))
        .sort((a, b) => (Number(b.createdAt || b.startedAt) || 0) - (Number(a.createdAt || a.startedAt) || 0));
    let current;
    if (viewerQueuedWork.length) {
        current = viewerQueuedWork[0];
    } else if (req.user.role === 'admin' && !activeScanIsScheduled && activeScanJob && ['running', 'fetching', 'processing'].includes(activeScanJob.status) && !activeScanJob.dismissed) {
        current = safeProgressSnapshot(activeScanJob, 'scan');
    } else if (running.length) {
        current = running.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0))[0];
    } else {
        current = candidates.sort((a, b) => (Number(b.completedAt || b.startedAt) || 0) - (Number(a.completedAt || a.startedAt) || 0))[0];
    }
    res.set('Cache-Control', 'no-store');
    res.json(current || { status: 'idle', jobType: null, progress: 0, total: 0, message: '' });
});

app.post('/api/progress/dismiss', requireLogin, (req, res) => {
    const type = String(req.body && req.body.type || '');
    let job = null;
    if (type === 'import') {
        const currentJob = activeJobs[req.user.id];
        if (currentJob && ['queued', 'fetching', 'processing'].includes(currentJob.status)) {
            return res.status(409).json({ success: false, message: currentJob.status === 'queued'
                ? 'This sync/import is waiting in the queue. Remove it from the Work Queue to cancel it.'
                : 'This sync/import is still running and cannot be dismissed yet.' });
        }
        delete activeJobs[req.user.id];
        return res.json({ success: true });
    }
    if (type === 'scan' && req.user.role === 'admin') {
        if (['running', 'fetching', 'processing'].includes(activeScanJob.status)) return res.status(409).json({ success: false, message: 'The scan is still running and cannot be dismissed yet.' });
        activeScanJob = { status: 'idle', type: '', progress: 0, total: 0, message: '', dismissed: true };

        if (activeOrganizerJob && !['running', 'fetching', 'processing'].includes(activeOrganizerJob.status)) {
            activeOrganizerJob.dismissed = true;
        }
        return res.json({ success: true });
    }
    if ((type === 'organizer' || type === 'bulk-review') && req.user.role === 'admin') job = activeOrganizerJob;
    else if (type === 'dead-files-bulk' && req.user.role === 'admin') job = activeDeadFileJob;
    else if (type === 'library-path' && req.user.role === 'admin') job = activeLibraryPathJob;
    else if (type === 'missing-logs-bulk') job = activeMissingLogJobs.get(req.user.id);
    else if (type === 'restore-tracks-bulk') job = activeRestoreJobs.get(req.user.id);
    if (!job) return res.json({ success: true });
    if (['running', 'fetching', 'processing'].includes(job.status)) return res.status(409).json({ success: false, message: 'This task is still running and cannot be dismissed yet.' });
    job.dismissed = true;
    res.json({ success: true });
});

function scheduleLibraryLinkReconciliation(userId, userLibraryPath, indexMode, liveIds) {
    const now = Date.now();
    if (now - (lastLibraryLinkReconcileAt.get(userId) || 0) < 60000) return;
    lastLibraryLinkReconcileAt.set(userId, now);
    const tracks = db.prepare(`SELECT c.id, c.file_path FROM user_tracks ut JOIN catalog c ON c.id = ut.track_id WHERE ut.user_id = ?`).all(userId);

    setImmediate(async () => {
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            try {

                if (!db.prepare('SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?').get(userId, track.id)) continue;
                if (!liveIds.has(track.id) || !fs.existsSync(track.file_path)) continue;

                reconcileUserLibraryLinksForCatalogTrack(track.id, [], track.file_path, userId);
            } catch (_) {}
            if (i % 100 === 0) await new Promise(resolve => setImmediate(resolve));
        }
    });
}

async function runOrganizerPipeline(trigger = 'manual', requestedBy = null) {
    if (activeOrganizerJob.status === 'running' || organizer.running) {
        return { busy: true, message: 'Organizer is already running.' };
    }
    const nestedInScan = String(trigger).toLowerCase().includes('scan');
    activeOrganizerJob = {
        status: 'running', task: 'organize', progress: 0, total: 0,
        message: `Starting organizer (${trigger})...`, result: null,
        startedAt: Date.now(), dismissed: false, nestedInScan
    };
    if (!nestedInScan) startStandaloneTaskHistory(activeOrganizerJob, requestedBy, 'Organizer Processing', trigger);
    try {
        const result = await organizer.processDumps({
            onProgress: progress => {
                activeOrganizerJob.progress = progress.processed || 0;
                activeOrganizerJob.total = progress.total || 0;
                activeOrganizerJob.message = `${progress.message || 'Organizer is working...'}${progress.currentPath ? ` — ${path.basename(progress.currentPath)}` : ''}`;
                activeOrganizerJob.stage = progress.stage || '';

                if (String(trigger).toLowerCase().includes('scan') && (activeScanJob.status === 'running' || activeScanJob.status === 'fetching')) {
                    activeScanJob.stage = 'organizer';
                    activeScanJob.progress = progress.processed || 0;
                    activeScanJob.total = progress.total || 0;
                    activeScanJob.message = activeOrganizerJob.message;
                }
            }
        });
        if (result.busy) {
            activeOrganizerJob = { ...activeOrganizerJob, status: 'completed', task: 'organize', progress: 0, total: 0, message: result.message, result, startedAt: activeOrganizerJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false, nestedInScan };
            if (!nestedInScan) persistStandaloneTaskHistory(activeOrganizerJob);
            return result;
        }
        invalidateLiveCatalogSnapshot();
        const summary = `Organizer finished: ${result.organized} organized, ${result.duplicates} byte-identical duplicates found, ${result.review} items awaiting review, ${result.skipped} skipped${result.errors ? `, ${result.errors} errors` : ''}.`;
        activeOrganizerJob = { ...activeOrganizerJob, status: 'completed', task: 'organize', progress: result.total || result.processed, total: result.total, message: summary, result, startedAt: activeOrganizerJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false, nestedInScan };
        if (!nestedInScan) persistStandaloneTaskHistory(activeOrganizerJob);
        return result;
    } catch (error) {
        invalidateLiveCatalogSnapshot();
        lastLibraryLinkReconcileAt.clear();
        activeOrganizerJob = { ...activeOrganizerJob, status: 'error', task: 'organize', progress: activeOrganizerJob.progress, total: activeOrganizerJob.total, message: error.message, errorTrace: error.stack || error.message, result: null, startedAt: activeOrganizerJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false, nestedInScan };
        if (!nestedInScan) persistStandaloneTaskHistory(activeOrganizerJob);
        throw error;
    }
}

async function runOrganizerBulkReview(ids, action) {
    const errors = [];
    let succeeded = 0;
    for (let i = 0; i < ids.length; i++) {
        try {
            await organizer.resolveReview(ids[i], action);
            succeeded++;
        } catch (error) {
            errors.push({ id: ids[i], message: error.message });
        }
        activeOrganizerJob.progress = i + 1;
        activeOrganizerJob.total = ids.length;
        activeOrganizerJob.message = `Bulk organizer review (${action}): ${i + 1} / ${ids.length}`;
        if (i % 5 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    const failed = errors.length;
    invalidateLiveCatalogSnapshot();
    lastLibraryLinkReconcileAt.clear();
    activeOrganizerJob = {
        ...activeOrganizerJob,
        status: failed === ids.length && failed > 0 ? 'error' : 'completed', task: 'bulk-review', progress: ids.length, total: ids.length,
        message: `Bulk review finished: ${succeeded} succeeded${failed ? `, ${failed} need attention` : ''}.`,
        errorTrace: failed ? errors.map(item => `Review item ${item.id}: ${item.message}`).join('\n') : '',
        result: { action, succeeded, failed, errors: errors.slice(0, 30) },
        startedAt: activeOrganizerJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false
    };
    persistStandaloneTaskHistory(activeOrganizerJob);
}

async function executeMasterPoolScan(trigger = 'manual master-pool scan') {
    if (!fs.existsSync(MASTER_POOL_DIR)) throw new Error('Master pool directory not found.');
    if (activeScanJob.status === 'running' || activeScanJob.status === 'fetching') {
        throw new Error('A master-pool scan is already running.');
    }
    if (activeOrganizerJob.status === 'running' || organizer.running) {
        throw new Error('Wait for the organizer to finish before starting a master-pool scan.');
    }

    invalidateLiveCatalogSnapshot();
    activeScanJob = { status: 'fetching', type: 'full', progress: 0, total: 0, message: `${trigger}: discovering audio files...`, trigger, queueId: activeScanJob.queueId || activeQueueTaskId || null, startedAt: Date.now(), dismissed: false };
    try {
        const exemptPaths = getExemptPaths();
        const inaccessiblePoolDirectories = [];
        const files = await walkDir(MASTER_POOL_DIR, exemptPaths, progress => {
            activeScanJob.message = `${trigger}: discovering audio files and folders (${progress.visitedEntries} directory entries checked)...`;
        }, issue => inaccessiblePoolDirectories.push(issue.directory));
        activeScanJob.total = files.length;
        activeScanJob.status = 'running';
        let scanned = 0;
        const insertStmt = db.prepare(`
            INSERT INTO catalog (file_path, title, artist, album, search_str, added_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(file_path) DO UPDATE SET
                title=excluded.title, artist=excluded.artist, album=excluded.album,
                search_str=excluded.search_str, added_at=excluded.added_at
        `);
        const transaction = db.transaction(batch => {
            for (const item of batch) insertStmt.run(item.full_path, item.title, item.artist, item.album, item.search_str, item.mtime);
        });
        let batch = [];
        for (let i = 0; i < files.length; i++) {
            if (i % 10 === 0) await new Promise(resolve => setImmediate(resolve));
            const fullPath = files[i];
            activeScanJob.message = `Re-indexing and checking file identity: ${i + 1} / ${files.length}`;
            activeScanJob.stage = 'pool-index';
            let metadataTags = null;
            try {

                const indexed = await organizer.indexPoolFile(fullPath, {}, '', true);
                metadataTags = indexed.tags || {};
            } catch (identityError) {
                console.warn(`[Organizer] Could not force-refresh file identity for ${fullPath}: ${identityError.message}`);

                metadataTags = await extractTags(fullPath);
            }
            const title = String(metadataTags.title || path.parse(fullPath).name);
            const artist = String(metadataTags.artist || metadataTags.albumartist || 'Unknown');
            const album = String(metadataTags.album || 'Unknown');
            const cleanSearch = `${artist} ${title}`.replace(/[^\w\s]/g, ' ').trim().toLowerCase();
            let mtime = 0;
            try { mtime = fs.statSync(fullPath).mtimeMs / 1000; } catch (_) {}
            batch.push({ full_path: fullPath, title, artist, album, search_str: cleanSearch, mtime });
            if (batch.length >= 100) {
                transaction(batch);
                scanned += batch.length;
                batch = [];
            }
            activeScanJob.progress = i + 1;
        }
        if (batch.length) {
            transaction(batch);
            scanned += batch.length;
        }

        const mergedPathAliases = mergeCatalogPathAliases(files);
        activeScanJob.message = mergedPathAliases
            ? `Merged ${mergedPathAliases} duplicate catalog path alias(es). Processing organizer staging folders...`
            : 'Processing organizer staging folders...';
        const organizerStartedAt = Date.now();
        let organizerResult = null;
        try { organizerResult = await runOrganizerPipeline(trigger); }
        catch (organizerError) { console.error('[Organizer] Scan pipeline failed:', organizerError.message); }

        let autoApprovalSummary = '';
        const isScheduled = String(trigger).toLowerCase().includes('scheduled');
        const autoApprovalSetting = db.prepare("SELECT value FROM scan_settings WHERE key = 'auto_approve_metadata'").get()?.value === '1';
        if (isScheduled && autoApprovalSetting && organizerResult && !organizerResult.busy) {
            try {
                const autoApproved = await organizer.autoApprovePendingMetadataWithoutConflicts(organizerStartedAt);
                autoApprovalSummary = ` Automatically approved ${autoApproved.approved} conflict-free metadata item(s)`
                    + (autoApproved.skipped ? `; ${autoApproved.skipped} item(s) remained in review` : '') + '.';
            } catch (approvalError) {
                console.warn('[Organizer] Scheduled metadata auto-approval failed:', approvalError.message);
                autoApprovalSummary = ' Scheduled metadata auto-approval did not finish; remaining items are still available for review.';
            }
        }

        let repairedCatalogPaths = 0;
        try { repairedCatalogPaths = await reconcileDeadCatalogPaths(files); }
        catch (repairError) { console.warn('[Catalog] Dead-path reconciliation failed:', repairError.message); }
        invalidateLiveCatalogSnapshot();
        lastLibraryLinkReconcileAt.clear();
        const repairSummary = repairedCatalogPaths ? ` Repaired ${repairedCatalogPaths} moved/upgraded catalog path(s) using matching embedded metadata.` : '';
        const organizerSummary = organizerResult && !organizerResult.busy
            ? ` Organizer: ${organizerResult.organized} organized, ${organizerResult.duplicates} byte-identical duplicates found, ${organizerResult.review} items awaiting review, ${organizerResult.skipped} skipped${organizerResult.errors ? `, ${organizerResult.errors} errors` : ''}.`
            : (organizerResult && organizerResult.busy ? ' Organizer was already running.' : ' Organizer could not complete; see server logs.');
        let finalAvailable = scanned;
        try { finalAvailable = countLiveCatalogPoolTracks(); }
        catch (countError) { console.warn('[Catalog] Could not calculate final catalog count:', countError.message); }
        const aliasSummary = mergedPathAliases ? ` Consolidated ${mergedPathAliases} duplicate case-variant catalog path(s).` : '';
        activeScanJob = {
            status: 'completed', type: 'full',
            message: `Full catalog and organizer scan completed. Catalog now contains ${finalAvailable} available pool tracks.${organizerSummary}${repairSummary}${autoApprovalSummary}${aliasSummary}${inaccessiblePoolDirectories.length ? ` ${inaccessiblePoolDirectories.length} pool folder(s) could not be enumerated; verify access before relying on the scan as complete.` : ''}`,
            progress: finalAvailable, total: finalAvailable, trigger,
            queueId: activeScanJob.queueId || activeQueueTaskId || null,
            startedAt: activeScanJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false
        };
        invalidateDeadFileResultsCache();
        const completedAt = String(Date.now() / 1000);
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('last_master_scan', ?)").run(completedAt);

        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('last_incremental_scan', ?)").run(completedAt);
        queueWantedTracksRefresh('detailed full scan');
        return activeScanJob;
    } catch (error) {
        activeScanJob = { status: 'error', type: 'full', progress: activeScanJob.progress || 0, total: activeScanJob.total || 0, message: error.message, errorTrace: error.stack || error.message, trigger, queueId: activeScanJob.queueId || activeQueueTaskId || null, startedAt: activeScanJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false };
        const failedAt = String(Date.now() / 1000);
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('last_master_scan', ?)").run(failedAt);
        throw error;
    }
}

async function executeIncrementalPoolScan(trigger = 'manual quick scan') {
    if (!fs.existsSync(MASTER_POOL_DIR)) throw new Error('Master pool directory not found.');
    if (activeScanJob.status === 'running' || activeScanJob.status === 'fetching') {
        throw new Error('A catalog scan is already running.');
    }
    if (activeOrganizerJob.status === 'running' || organizer.running) {
        throw new Error('Wait for the organizer to finish before starting a quick scan.');
    }

    const hasCatalogRows = !!db.prepare('SELECT 1 FROM catalog LIMIT 1').get();
    const hasPoolIdentityIndex = !!organizer.db.prepare("SELECT 1 FROM file_records WHERE source_type = 'pool' LIMIT 1").get();
    if (!hasCatalogRows || !hasPoolIdentityIndex) {
        console.log('[Catalog] Quick scan requested without an established catalog/index; using the detailed full scan.');
        const result = await executeMasterPoolScan(`${trigger}; catalog/pool empty or not indexed, running detailed full scan`);
        const completedAt = String(Date.now() / 1000);
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('last_incremental_scan', ?)").run(completedAt);
        return result;
    }

    invalidateLiveCatalogSnapshot();
    activeScanJob = { status: 'fetching', type: 'incremental', progress: 0, total: 0,
        message: `${trigger}: checking file paths, sizes, and modification times...`, trigger, queueId: activeScanJob.queueId || activeQueueTaskId || null, startedAt: Date.now(), dismissed: false };
    try {
        const exemptPaths = getExemptPaths();
        const inaccessiblePoolDirectories = [];
        const files = await walkDir(MASTER_POOL_DIR, exemptPaths, progress => {
            activeScanJob.message = `${trigger}: discovering new/changed-song candidates (${progress.visitedEntries} directory entries checked)...`;
        }, issue => inaccessiblePoolDirectories.push(issue.directory));
        if (files.length === 0 && inaccessiblePoolDirectories.length) {
            throw new Error(`The quick scan could not inspect ${inaccessiblePoolDirectories.length} pool folder(s), so it cannot confirm whether the pool is empty. Check drive and folder permissions, then retry. The detailed scan was not started to avoid a misleading empty-pool result.`);
        }
        if (files.length === 0) {
            activeScanJob = { status: 'idle', type: 'incremental', trigger, queueId: activeScanJob.queueId || activeQueueTaskId || null, progress: 0, total: 0, message: '' };
            const result = await executeMasterPoolScan(`${trigger}; pool contains no discoverable audio files, running detailed full scan`);
            const completedAt = String(Date.now() / 1000);
            db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('last_incremental_scan', ?)").run(completedAt);
            return result;
        }
        activeScanJob.total = files.length;
        activeScanJob.status = 'running';

        const pathKey = deadCandidatePathKey;
        const records = organizer.db.prepare("SELECT file_path, sha256, size, mtime_ms, metadata_json FROM file_records WHERE source_type = 'pool'").all();
        const recordByPath = new Map(records.map(row => [pathKey(row.file_path), row]));
        const catalogRows = db.prepare('SELECT id, file_path, title, artist, album FROM catalog').all();
        const catalogByPath = new Map(catalogRows.map(row => [pathKey(row.file_path), row]));
        const seenKeys = new Set();
        let newFiles = 0;
        let changedFiles = 0;
        let recoveredCatalogRows = 0;
        let skippedFiles = 0;

        for (let i = 0; i < files.length; i++) {
            const filePath = normalizeFilesystemPath(files[i]);
            const key = pathKey(filePath);
            seenKeys.add(key);
            let stat;
            try { stat = await fs.promises.stat(filePath); }
            catch (_) { skippedFiles++; continue; }
            if (!stat.isFile() || !Organizer.pathIsInside(filePath, MASTER_POOL_DIR)
                || exemptPaths.some(exempt => pathSameOrInside(filePath, exempt))) { skippedFiles++; continue; }

            const oldRecord = recordByPath.get(key) || null;
            const catalogRow = catalogByPath.get(key) || null;
            const statChanged = !oldRecord || Number(oldRecord.size) !== stat.size
                || Math.abs(Number(oldRecord.mtime_ms || 0) - stat.mtimeMs) >= 1;
            let tags = oldRecord ? organizer.safeJson(oldRecord.metadata_json, {}) : {};

            if (statChanged) {
                activeScanJob.message = `Hashing and refreshing new/changed files: ${i + 1} / ${files.length}`;
                try {
                    const indexed = await organizer.indexPoolFile(filePath, {}, '', false);
                    tags = indexed.tags || tags;
                } catch (error) {
                    console.warn(`[Catalog] Could not index changed file ${filePath}: ${error.message}`);
                    try { tags = await organizer.readTags(filePath); }
                    catch (_) { skippedFiles++; continue; }
                }
                if (oldRecord) changedFiles++;
                else newFiles++;
            } else if (Number(tags._organizer_metadata_version) !== 7) {

                try {
                    const refreshed = await organizer.indexPoolFile(filePath, {}, '', false);
                    tags = refreshed.tags || tags;
                } catch (_) {
                    try { tags = await organizer.readTags(filePath); } catch (_) {}
                }
            }

            if (statChanged || !catalogRow || !tags.title || !(tags.artist || tags.albumartist)) {
                if (!tags.title || !(tags.artist || tags.albumartist)) {
                    try { tags = await organizer.readTags(filePath); } catch (_) {}
                }
                upsertCatalogTrack(filePath, tags);

                if (statChanged && catalogRow && !oldRecord) {
                    try {
                        if (updateCatalogTrackPath(filePath, filePath, tags) === false) {
                            console.warn(`[Catalog] Could not reconcile same-path library links for ${filePath}.`);
                        }
                    } catch (linkError) {
                        console.warn(`[Catalog] Same-path library-link reconciliation failed for ${filePath}: ${linkError.message}`);
                    }
                }
                if (!catalogRow && oldRecord) recoveredCatalogRows++;
            }

            activeScanJob.progress = i + 1;
            if (i % 50 === 0) await new Promise(resolve => setImmediate(resolve));
        }

        const mergedPathAliases = mergeCatalogPathAliases(files);

        const staleRecords = records.filter(row => !seenKeys.has(pathKey(row.file_path))
            && !inaccessiblePoolDirectories.some(directory => pathSameOrInside(row.file_path, directory)));
        const deleteRecord = organizer.db.prepare("DELETE FROM file_records WHERE file_path = ? AND source_type = 'pool'");
        const deleteStale = organizer.db.transaction(rows => { for (const row of rows) deleteRecord.run(normalizeFilesystemPath(row.file_path)); });
        deleteStale(staleRecords);

        activeScanJob.message = 'Checking and recovering catalog paths for moved/upgraded songs...';
        let repairedCatalogPaths = 0;
        try { repairedCatalogPaths = await reconcileDeadCatalogPaths(files); }
        catch (error) { console.warn('[Catalog] Quick-scan dead-path reconciliation failed:', error.message); }

        invalidateLiveCatalogSnapshot();
        lastLibraryLinkReconcileAt.clear();
        const finalAvailable = db.prepare('SELECT file_path FROM catalog').all()
            .filter(row => seenKeys.has(pathKey(row.file_path))
                || inaccessiblePoolDirectories.some(directory => pathSameOrInside(row.file_path, directory))).length;
        invalidateDeadFileResultsCache();
        const completedAt = String(Date.now() / 1000);
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('last_incremental_scan', ?)").run(completedAt);
        activeScanJob = {
            status: 'completed', type: 'incremental', progress: files.length, total: files.length, trigger,
            message: `Quick scan completed. ${newFiles} new file(s), ${changedFiles} changed file(s), ${recoveredCatalogRows} missing catalog row(s) restored, ${repairedCatalogPaths} stale catalog path(s) repaired. Catalog now contains ${finalAvailable} available pool tracks.${mergedPathAliases ? ` Consolidated ${mergedPathAliases} case-variant path(s).` : ''}${inaccessiblePoolDirectories.length ? ` ${inaccessiblePoolDirectories.length} pool folder(s) could not be read; cached identities under those folders were preserved.` : ''}${skippedFiles ? ` ${skippedFiles} file(s) could not be fully checked; use the detailed full scan if needed.` : ''}`,
            startedAt: activeScanJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false
        };
        queueWantedTracksRefresh('quick scan');
        return activeScanJob;
    } catch (error) {
        activeScanJob = { status: 'error', type: 'incremental', progress: activeScanJob.progress || 0,
            total: activeScanJob.total || 0, message: error.message, trigger, startedAt: activeScanJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false };
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('last_incremental_scan', ?)").run(String(Date.now() / 1000));
        throw error;
    }
}

app.post('/api/catalog/quick-scan', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (!fs.existsSync(MASTER_POOL_DIR)) return res.status(400).json({ success: false, message: 'Master pool directory not found.' });
    const queued = enqueueCatalogScan('incremental', 'manual quick scan', {
        requestedByUserId: req.user.id,
        requestedByUsername: req.user.username,
        label: 'Quick catalog scan'
    });
    res.json({
        success: true,
        queued: queued.task.status === 'queued',
        queue_id: queued.task.id,
        position: getQueueTaskPosition(queued.task.id),
        message: queued.coveredByFull
            ? (queued.task.status === 'running' ? 'A full catalog scan is already running and includes the quick-scan work.' : `A full catalog scan is already queued at position ${getQueueTaskPosition(queued.task.id)} and includes the quick-scan work.`)
            : (queued.existing
                ? (queued.task.status === 'running' ? 'A quick catalog scan is already running.' : `A quick catalog scan is already queued at position ${getQueueTaskPosition(queued.task.id)}.`)
                : (queued.task.status === 'running' ? 'Quick catalog scan started.' : `Quick catalog scan added to the queue at position ${getQueueTaskPosition(queued.task.id)}.`))
    });
});

app.post('/api/catalog/scan', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (!fs.existsSync(MASTER_POOL_DIR)) return res.status(400).json({ success: false, message: 'Master pool directory not found.' });
    const queued = enqueueCatalogScan('full', 'manual master-pool scan', {
        requestedByUserId: req.user.id,
        requestedByUsername: req.user.username,
        label: 'Full catalog and organizer scan'
    });
    res.json({
        success: true,
        queued: queued.task.status === 'queued',
        queue_id: queued.task.id,
        position: getQueueTaskPosition(queued.task.id),
        message: queued.existing
            ? (queued.task.status === 'running' ? 'A full catalog and organizer scan is already running.' : `A full catalog and organizer scan is already queued at position ${getQueueTaskPosition(queued.task.id)}.`)
            : (queued.task.status === 'running' ? 'Full catalog and organizer scan started.' : `Full catalog and organizer scan added to the queue at position ${getQueueTaskPosition(queued.task.id)}.`)
    });
});

app.get('/api/catalog/scan-status', requireLogin, (req, res) => {

    if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    res.set('Cache-Control', 'no-store');
    res.json(activeScanJob);
});

app.post('/api/catalog/scan-dismiss', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (!['running', 'fetching', 'processing'].includes(activeScanJob.status)) {
        activeScanJob = { status: 'idle', type: '', progress: 0, total: 0, message: '', dismissed: true };

        if (activeOrganizerJob && !['running', 'fetching', 'processing'].includes(activeOrganizerJob.status)) {
            activeOrganizerJob.dismissed = true;
        }
    }
    res.json({ success: true });
});

app.route('/api/admin/users')
    .get(requireLogin, (req, res) => {
        if (req.user.role !== 'admin') return res.status(403).json({ success: false });
        const users = db.prepare(`SELECT id, username, role, library_path, index_mode FROM users`).all();
        res.json(users);
    })
    .post(requireLogin, (req, res) => {
        if (req.user.role !== 'admin') return res.status(403).json({ success: false });
        const { username, password, library_path, index_mode } = req.body;
        const selectedMode = index_mode === 'advanced' ? 'advanced' : 'standard';
        const selectedRole = req.body.role === 'admin' ? 'admin' : 'user';

        if (!library_path) return res.status(400).json({ success: false, message: "Library path is required." });

        const normalizedPath = resolveUserLibraryPath(library_path);
        const existingUsers = db.prepare(`SELECT id, library_path FROM users`).all();
        if (existingUsers.some(u => sameResolvedPath(resolveUserLibraryPath(u.library_path), normalizedPath))) {
            return res.status(400).json({ success: false, message: "Library path is already in use by another user." });
        }

        try { fs.mkdirSync(normalizedPath, { recursive: true }); } catch (e) { return res.status(400).json({ success: false, message: `Path error: ${e.message}` }); }
        try {
            const hash = bcrypt.hashSync(password, 10);
            db.prepare(`INSERT INTO users (username, password_hash, role, library_path, index_mode) VALUES (?, ?, ?, ?, ?)`)
              .run(username, hash, selectedRole, normalizedPath, selectedMode);
            res.json({ success: true, message: "User created." });
        } catch (e) {
            if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ success: false, message: "Username exists" });
            res.status(500).json({ success: false, message: "Database error" });
        }
    });

app.put('/api/admin/users/:user_id', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (activeLibraryPathJob.status === 'running') return res.status(409).json({ success: false, message: 'A user library path task is already running.' });
    const targetId = Number.parseInt(req.params.user_id, 10);
    const { username, password, library_path, index_mode } = req.body;
    const selectedMode = index_mode === 'advanced' ? 'advanced' : 'standard';
    const selectedRole = req.body.role === 'admin' ? 'admin' : 'user';
    if (!library_path || !String(library_path).trim()) return res.status(400).json({ success: false, message: 'Library path is required.' });
    const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!targetUser) return res.status(404).json({ success: false, message: 'User not found.' });
    if (targetUser.role === 'admin' && selectedRole !== 'admin'
        && db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'").get().total <= 1) {
        return res.status(400).json({ success: false, message: 'At least one administrator must remain. Promote another user before changing this account to User.' });
    }
    let newPath;
    try { newPath = resolveUserLibraryPath(library_path); }
    catch (error) { return res.status(400).json({ success: false, message: error.message }); }
    const existingUsers = db.prepare('SELECT id, library_path FROM users').all();
    if (existingUsers.some(u => u.id !== targetId && sameResolvedPath(resolveUserLibraryPath(u.library_path), newPath))) {
        return res.status(400).json({ success: false, message: 'Library path is already in use by another user.' });
    }
    let passwordHash = targetUser.password_hash;
    try { if (password && password.trim()) passwordHash = bcrypt.hashSync(password, 10); }
    catch (error) { return res.status(400).json({ success: false, message: `Could not update password: ${error.message}` }); }

    const oldPath = resolveUserLibraryPath(targetUser);
    const pathChanged = !sameResolvedPath(oldPath, newPath);
    if (pathChanged) {
        try { fs.mkdirSync(newPath, { recursive: true }); }
        catch (error) { return res.status(400).json({ success: false, message: `Path error: ${error.message}` }); }
        activeLibraryPathJob = {
            status: 'running', task: 'library-path-migration', targetUserId: targetId, startedAt: Date.now(), dismissed: false,
            progress: 0, total: 0, message: `Preparing to move ${targetUser.username}'s library links...`, result: null,
            newPath, newMode: selectedMode, newRole: selectedRole, username: String(username || targetUser.username).trim(), passwordHash
        };
        startStandaloneTaskHistory(activeLibraryPathJob, req.user, 'User Library Path Migration', `Library path migration for ${targetUser.username}`);
        res.json({ success: true, task: 'library-path-migration', message: `Started moving ${targetUser.username}'s library to the new path.` });
        setImmediate(() => runLibraryPathMigration(activeLibraryPathJob));
        return;
    }

    try {
        if ((targetUser.index_mode || 'standard') !== selectedMode) convertUserLinks(targetId, selectedMode);
        if (passwordHash !== targetUser.password_hash) {
            db.prepare('UPDATE users SET username = ?, password_hash = ?, library_path = ?, index_mode = ?, role = ? WHERE id = ?')
                .run(String(username || targetUser.username).trim(), passwordHash, newPath, selectedMode, selectedRole, targetId);
        } else {
            db.prepare('UPDATE users SET username = ?, library_path = ?, index_mode = ?, role = ? WHERE id = ?')
                .run(String(username || targetUser.username).trim(), newPath, selectedMode, selectedRole, targetId);
        }
        res.json({ success: true, message: 'User updated.' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message || 'Could not update user settings.' });
    }
});

app.get('/api/admin/users/library-path/job-status', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { passwordHash, newPath, ...visibleJob } = activeLibraryPathJob;
    res.json(visibleJob);
});

app.delete('/api/admin/users/:user_id', requireLogin, (req, res) => {
    const targetId = Number.parseInt(req.params.user_id, 10);
    if (req.user.role !== 'admin' || req.user.id === targetId) return res.status(403).json({ success: false, message: 'Unauthorized or invalid target' });
    if (activeLibraryPathJob.status === 'running') return res.status(409).json({ success: false, message: 'A user library path task is already running.' });
    const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
    activeLibraryPathJob = { status: 'running', task: 'user-delete', targetUserId: targetId, startedAt: Date.now(), dismissed: false, progress: 0, total: 0,
        message: `Preparing to remove managed library links for ${target.username}...`, result: null };
    startStandaloneTaskHistory(activeLibraryPathJob, req.user, 'User Deletion and Link Cleanup', `Delete user ${target.username}`);
    res.json({ success: true, task: 'user-delete', message: `Started deleting ${target.username} and cleaning up assigned song links.` });
    setImmediate(() => runUserDeletionJob(activeLibraryPathJob));
});

app.get('/api/admin/wanted-tracks', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Administrator access required.' });
    try {
        const settings = getWantedTracksSettings();
        let lines = readWantedTrackSnapshot();
        let listPending = false;
        let listError = '';
        if (lines === null) {
            if (wantedTracksSnapshotBuildError) {
                listError = wantedTracksSnapshotBuildError;
                lines = [];
            } else {
                queueWantedTracksSnapshotBuild();
                listPending = true;
                lines = [];
            }
        }
        let lastResult = null;
        try { lastResult = settings.last_result ? JSON.parse(settings.last_result) : null; } catch (_) {}
        res.json({
            success: true,
            mode: settings.mode,
            post_url: settings.post_url,
            file_path: settings.file_path,
            track_count: listPending ? null : lines.length,
            preview: lines.slice(0, 30),
            skipped_unformatted_count: listPending ? 0 : lastWantedTracksUnformattedCount,
            list_pending: listPending,
            list_error: listError,
            last_generated_at: settings.last_generated_at,
            last_count: settings.last_count,
            last_result: lastResult
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Could not load Wanted Tracks.' });
    }
});

app.post('/api/admin/wanted-tracks/settings', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Administrator access required.' });
    const mode = String(req.body.mode || 'file').trim().toLowerCase();
    if (!['file', 'post', 'both'].includes(mode)) {
        return res.status(400).json({ success: false, message: 'Choose text file, POST, or both for Wanted Tracks output.' });
    }
    let postUrl = '';
    try {
        if (mode === 'post' || mode === 'both') postUrl = validateWantedTracksPostUrl(req.body.post_url, true);
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }

    saveWantedTracksSetting('wanted_tracks_mode', mode);
    saveWantedTracksSetting('wanted_tracks_post_url', postUrl);
    res.json({ success: true, message: 'Wanted Tracks settings saved.', mode, post_url: postUrl, file_path: displayFilesystemPath(WANTED_TRACKS_FILE) });
});

app.post('/api/admin/wanted-tracks/generate', requireLogin, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Administrator access required.' });
    try {
        const result = await generateAndDeliverWantedTracks('manual generation');
        res.status(result.success ? 200 : 502).json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Could not generate Wanted Tracks.' });
    }
});

app.get('/api/admin/wanted-tracks/download', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Administrator access required.' });
    try {
        const lines = getCurrentWantedTrackLines();
        const content = lines.length ? `${lines.join('\n')}\n` : '';
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="wanted-tracks.txt"');
        res.send(content);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Could not generate the wanted-track text.' });
    }
});

app.get('/api/admin/scan-settings', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const rows = db.prepare("SELECT * FROM scan_settings").all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    settings.auto_approve_metadata = settings.auto_approve_metadata === '1';

    if (settings.exempt_folders) {
        try { settings.exempt_folders = JSON.parse(settings.exempt_folders); }
        catch (e) { settings.exempt_folders = []; }
    } else {
        settings.exempt_folders = [];
    }

    if (settings.dump_folders) {
        try { settings.dump_folders = JSON.parse(settings.dump_folders); }
        catch (e) { settings.dump_folders = []; }
    } else {
        settings.dump_folders = [];
        if (settings.dump_folder && settings.dump_folder.trim()) {
            settings.dump_folders.push({ path: settings.dump_folder.trim(), user_id: null });
        }
    }

    if (!settings.trash_folder) {
        settings.trash_folder = '';
    }

    settings.organizer = organizer.getSettings();

    const users = db.prepare("SELECT id, username FROM users").all();
    settings.users = users;

    res.json(settings);
});

app.post('/api/admin/scan-settings', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const { master_scan_interval, incremental_scan_interval, exempt_folders, dump_folders, dump_folder, trash_folder, naming_script, organizer_rename_files, auto_approve_metadata } = req.body;

    const normalizedMasterSchedule = normalizeIntervalToSchedule(master_scan_interval, MASTER_SCAN_SCHEDULES);
    const previousMasterSchedule = db.prepare("SELECT value FROM scan_settings WHERE key = 'master_scan_interval'").get()?.value;
    db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('master_scan_interval', ?)").run(String(normalizedMasterSchedule));

    if (String(previousMasterSchedule || '0') !== String(normalizedMasterSchedule)) {
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('last_master_scan', ?)").run(String(Date.now() / 1000));
    }

    const normalizedIncrementalSchedule = normalizeIntervalToSchedule(incremental_scan_interval, INCREMENTAL_SCAN_SCHEDULES);
    const previousIncrementalSchedule = db.prepare("SELECT value FROM scan_settings WHERE key = 'incremental_scan_interval'").get()?.value;
    db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('incremental_scan_interval', ?)").run(String(normalizedIncrementalSchedule));
    if (String(previousIncrementalSchedule || '0') !== String(normalizedIncrementalSchedule)) {
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('last_incremental_scan', ?)").run(String(Date.now() / 1000));
    }
    if (auto_approve_metadata !== undefined) {
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('auto_approve_metadata', ?)").run(auto_approve_metadata ? '1' : '0');
    }

    if (Array.isArray(exempt_folders)) {
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('exempt_folders', ?)").run(JSON.stringify(exempt_folders));
    }

    if (Array.isArray(dump_folders)) {
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('dump_folders', ?)").run(JSON.stringify(dump_folders));
    } else if (dump_folder !== undefined) {
        const legacyArr = dump_folder.trim() ? [{ path: dump_folder.trim(), user_id: null }] : [];
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('dump_folders', ?)").run(JSON.stringify(legacyArr));
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('dump_folder', ?)").run(dump_folder.trim());
    }

    if (trash_folder !== undefined) {
        db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('trash_folder', ?)").run(trash_folder.trim());
    }

    if (naming_script !== undefined || organizer_rename_files !== undefined) {
        try {
            const current = organizer.getSettings();
            organizer.saveSettings({
                naming_script: naming_script === undefined ? current.naming_script : naming_script,
                rename_files: organizer_rename_files === undefined ? current.rename_files === '1' : !!organizer_rename_files
            });
        } catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    }

    res.json({ success: true, message: "System settings saved." });
});

app.get('/api/admin/dead-files/job-status', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    res.json(activeDeadFileJob);
});

app.post('/api/admin/dead-files/repair/bulk', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (activeDeadFileJob.status === 'running') return res.status(409).json({ success: false, message: 'A Dead Files task is already running.' });
    if (activeScanJob.status === 'running' || activeScanJob.status === 'fetching' || activeOrganizerJob.status === 'running' || organizer.running || hasActiveSyncJobs()) {
        return res.status(409).json({ success: false, message: 'Wait for active scan, organizer, or sync work to finish before repairing catalog paths.' });
    }
    const incoming = Array.isArray(req.body.items) ? req.body.items : [];
    const seen = new Set();
    const items = [];
    for (const entry of incoming) {
        const id = Number.parseInt(entry && entry.id, 10);
        const replacementPath = String(entry && entry.replacement_path || '').trim();
        if (!Number.isSafeInteger(id) || id <= 0 || !replacementPath || replacementPath.length > 5000 || seen.has(id)) continue;
        seen.add(id);
        items.push({ id, replacement_path: replacementPath });
    }
    if (!items.length) return res.status(400).json({ success: false, message: 'Select one or more repairable Dead Files entries first.' });
    if (items.length > 10000) return res.status(400).json({ success: false, message: 'A single repair run is limited to 10,000 catalog entries.' });
    activeDeadFileJob = { status: 'running', task: 'dead-files-repair', progress: 0, total: items.length,
        message: `Preparing replacement matches for ${items.length} selected catalog entr${items.length === 1 ? 'y' : 'ies'}...`, result: null, startedAt: Date.now(), dismissed: false };
    startStandaloneTaskHistory(activeDeadFileJob, req.user, 'Dead Files — Repair Selected', 'Dead Files repair');
    res.json({ success: true, total: items.length, message: `Started catalog repair for ${items.length} entr${items.length === 1 ? 'y' : 'ies'}.` });
    setImmediate(() => runDeadFileRepairJob(items));
});

app.post('/api/admin/dead-files/purge', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (activeDeadFileJob.status === 'running') return res.status(409).json({ success: false, message: 'A Dead Files task is already running.' });
    if (activeScanJob.status === 'running' || activeScanJob.status === 'fetching' || activeOrganizerJob.status === 'running' || organizer.running || hasActiveSyncJobs()) {
        return res.status(409).json({ success: false, message: 'Wait for active scan, organizer, or sync work to finish before purging dead catalog entries.' });
    }
    activeDeadFileJob = { status: 'running', task: 'dead-files-purge', progress: 0, total: 0,
        message: 'Preparing to check catalog paths...', result: null, startedAt: Date.now(), dismissed: false };
    startStandaloneTaskHistory(activeDeadFileJob, req.user, 'Dead Files — Scan and Purge', 'Dead Files purge');
    res.json({ success: true, message: 'Started the Dead Files catalog check.' });
    setImmediate(() => runDeadFilesPurgeJob());
});

app.get('/api/admin/dead-files', requireLogin, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    try { res.json(await getDeadFileRowsWithSuggestions()); }
    catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/admin/dead-files/:id/repair', requireLogin, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    const deadId = Number.parseInt(req.params.id, 10);
    const newPath = normalizeFilesystemPath(String(req.body.replacement_path || ''));
    const deadRow = db.prepare('SELECT id, file_path, title, artist, album FROM catalog WHERE id = ?').get(deadId);
    if (!deadRow || fs.existsSync(deadRow.file_path)) return res.status(400).json({ success: false, message: 'This catalog entry is not a dead file anymore.' });
    if (!isLiveCatalogPoolPath(newPath)) return res.status(400).json({ success: false, message: 'The replacement must be an existing audio file inside the indexed Master Pool, outside dump, exempt, and Trash folders.' });
    try {
        const live = await getDeadFileCandidateRows([deadRow]);
        const matches = deadRowMatchOptions(deadRow, buildDeadCandidateTitleIndex(live), getExemptPaths());
        const approvedCandidate = matches.find(item => normalizeFilesystemPath(item.file_path) === newPath);
        if (!approvedCandidate) return res.status(400).json({ success: false, message: 'The replacement file does not have matching embedded title and artist metadata.' });
        const replacement = approvedCandidate;
        const tags = replacement.embedded || {};
        if (!updateCatalogTrackPath(deadRow.file_path, newPath, tags)) {
            return res.status(500).json({ success: false, message: 'Catalog repair failed; the existing catalog entry was left unchanged.' });
        }
        await organizer.removeDeadFileRecord(deadRow.file_path);
        invalidateDeadFileResultsCache();
        invalidateLiveCatalogSnapshot();
        lastLibraryLinkReconcileAt.clear();
        res.json({ success: true, message: `Catalog path repaired to ${newPath}. Existing library assignments were preserved.` });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.delete('/api/admin/dead-files/:id', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    const row = db.prepare('SELECT id, file_path FROM catalog WHERE id = ?').get(Number.parseInt(req.params.id, 10));
    if (!row) return res.status(404).json({ success: false, message: 'Catalog entry not found.' });
    if (fs.existsSync(row.file_path)) return res.status(400).json({ success: false, message: 'This file exists now and cannot be cleared as a dead entry.' });
    db.prepare('DELETE FROM catalog WHERE id = ?').run(row.id);
    organizer.removeDeadFileRecord(row.file_path).catch(() => {});
    invalidateDeadFileResultsCache();
    invalidateLiveCatalogSnapshot();
    res.json({ success: true, cleared: 1 });
});

app.delete('/api/admin/dead-files', requireLogin, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false });
    if (!fs.existsSync(MASTER_POOL_DIR)) return res.status(400).json({ success: false, message: 'Master pool directory missing. Aborting purge.' });
    try {
        const rows = db.prepare('SELECT id, file_path FROM catalog').all();
        const deadRows = await findMissingCatalogRows(rows, getExemptPaths());
        if (deadRows.length) {
            db.transaction(() => {
                for (let i = 0; i < deadRows.length; i += 900) {
                    const batch = deadRows.slice(i, i + 900);
                    db.prepare(`DELETE FROM catalog WHERE id IN (${batch.map(() => '?').join(',')})`).run(...batch.map(row => row.id));
                }
            })();
            for (const row of deadRows) organizer.removeDeadFileRecord(row.file_path).catch(() => {});
            invalidateDeadFileResultsCache();
            invalidateLiveCatalogSnapshot();
            lastLibraryLinkReconcileAt.clear();
        }
        res.json({ success: true, purged: deadRows.length });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/organizer/review', requireLogin, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    try {
        const reviews = await organizer.getPendingReviews({
            kind: req.query.kind || 'all',
            search: req.query.q || '',
            location: req.query.location || 'all',
            page: req.query.page,
            limit: req.query.limit
        });
        res.json({ success: true, ...reviews });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/organizer/status', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    const scanActive = ['running', 'fetching', 'processing'].includes(activeScanJob.status);

    res.json({ ...activeOrganizerJob, nestedInScan: scanActive || !!activeOrganizerJob.nestedInScan });
});

app.post('/api/admin/organizer/run', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (activeScanJob.status === 'running' || activeScanJob.status === 'fetching') {
        return res.status(409).json({ success: false, message: 'Wait for the master-pool scan to finish before running the organizer manually.' });
    }
    if (hasActiveSyncJobs()) {
        return res.status(409).json({ success: false, message: 'Wait for user sync/import jobs to finish before running the organizer.' });
    }
    if (activeOrganizerJob.status === 'running' || organizer.running) {
        return res.status(409).json({ success: false, message: 'Organizer is already running.' });
    }
    res.json({ success: true, message: 'Organizer started.' });
    runOrganizerPipeline('manual', req.user).catch(error => console.error('[Organizer] Manual run failed:', error.message));
});

app.post('/api/admin/organizer/review/bulk', requireLogin, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (activeOrganizerJob.status === 'running' || organizer.running) {
        return res.status(409).json({ success: false, message: 'Wait for the current organizer job to finish before processing review items.' });
    }
    if (hasActiveSyncJobs()) {
        return res.status(409).json({ success: false, message: 'Wait for sync/import jobs to finish before processing organizer reviews.' });
    }
    const action = String(req.body.action || '');
    if (!['approve', 'overwrite', 'upgrade', 'keep_both', 'keep_dump', 'stage_trash', 'delete'].includes(action)) {
        return res.status(400).json({ success: false, message: 'Unsupported bulk review action.' });
    }
    let ids = [];
    try {
        if (req.body.allFiltered) {
            const filters = req.body.filters || {};
            ids = await organizer.getPendingReviewIds({ kind: filters.kind || 'all', search: filters.search || '', location: filters.location || 'all' });
        } else if (Array.isArray(req.body.ids)) {
            ids = [...new Set(req.body.ids.map(value => Number.parseInt(value, 10)).filter(value => Number.isSafeInteger(value) && value > 0))];
        }
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
    if (!ids.length) return res.status(400).json({ success: false, message: 'Select at least one pending review item first.' });
    if (ids.length > 20000) return res.status(400).json({ success: false, message: 'Bulk review is limited to 20,000 items per run.' });
    activeOrganizerJob = { status: 'running', task: 'bulk-review', progress: 0, total: ids.length, message: `Starting bulk review (${action})...`, result: null, startedAt: Date.now(), dismissed: false };
    startStandaloneTaskHistory(activeOrganizerJob, req.user, 'Organizer Review — Bulk Action', `Organizer review: ${action}`);
    res.json({ success: true, message: `Started bulk review for ${ids.length} items.`, total: ids.length });
    runOrganizerBulkReview(ids, action).catch(error => {
        activeOrganizerJob = { ...activeOrganizerJob, status: 'error', task: 'bulk-review', progress: activeOrganizerJob.progress, total: activeOrganizerJob.total, message: error.message, errorTrace: error.stack || error.message, result: null, startedAt: activeOrganizerJob.startedAt || Date.now(), completedAt: Date.now(), dismissed: false };
        persistStandaloneTaskHistory(activeOrganizerJob);
        console.error('[Organizer] Bulk review failed:', error.message);
    });
});

app.post('/api/admin/organizer/review/:id/action', requireLogin, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Unauthorized' });
    if (activeOrganizerJob.status === 'running' || organizer.running) {
        return res.status(409).json({ success: false, message: 'Wait for the current organizer job to finish before resolving review items.' });
    }
    if (hasActiveSyncJobs()) {
        return res.status(409).json({ success: false, message: 'Wait for sync/import jobs to finish before resolving organizer reviews.' });
    }
    try {
        const result = await organizer.resolveReview(req.params.id, String(req.body.action || ''));
        invalidateLiveCatalogSnapshot();
        lastLibraryLinkReconcileAt.clear();
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/api/user/sync-settings', requireLogin, (req, res) => {
    const { provider, url, auto_sync, one_for_one, sync_interval, spotify_client_id, spotify_client_secret, apple_dev_token } = req.body;
    try {
        const normalizedSyncSchedule = normalizeIntervalToSchedule(sync_interval, USER_SYNC_SCHEDULES);
        db.transaction(() => {
            const previousSyncSchedule = db.prepare('SELECT sync_interval FROM users WHERE id = ?').get(req.user.id)?.sync_interval;
            db.prepare(`
                UPDATE users SET
                sync_provider = ?, sync_url = ?, auto_sync = ?, one_for_one = ?, sync_interval = ?,
                spotify_client_id = ?, spotify_client_secret = ?, apple_dev_token = ?
                WHERE id = ?
            `).run(
                (['spotify', 'youtube', 'apple'].includes(provider) ? provider : ''), String(url || '').trim(), auto_sync ? 1 : 0, one_for_one ? 1 : 0,
                normalizedSyncSchedule, spotify_client_id || '',
                spotify_client_secret || '', apple_dev_token || '', req.user.id
            );

            if (Number(previousSyncSchedule || 0) !== normalizedSyncSchedule) {
                db.prepare('UPDATE users SET last_sync = ? WHERE id = ?').run(Date.now() / 1000, req.user.id);
            }
            if (Object.prototype.hasOwnProperty.call(req.body, 'text_playlist')) {
                replaceTextPlaylist(req.user.id, req.body.text_playlist);
            }
        })();
        res.json({ success: true, message: "Sync settings and Text Playlist saved." });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message || 'Could not save sync settings and Text Playlist.' });
    }
});

app.get('/api/user/text-playlist', requireLogin, (req, res) => {
    const items = getTextPlaylistEntries(req.user.id);
    res.json({
        success: true,
        items,
        text: items.map(item => item.query).join('\n'),
        has_api_key: !!req.user.text_playlist_api_key_hash
    });
});

app.put('/api/user/text-playlist', requireLogin, (req, res) => {
    if (typeof req.body.text !== 'string') {
        return res.status(400).json({ success: false, message: 'Text Playlist input must be plain text.' });
    }
    const count = replaceTextPlaylist(req.user.id, req.body.text);
    res.json({ success: true, message: `Saved ${count} text playlist entr${count === 1 ? 'y' : 'ies'}.`, count });
});

app.post('/api/user/text-playlist/api-key', requireLogin, (req, res) => {
    const apiKey = `milo_${crypto.randomBytes(32).toString('hex')}`;
    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    db.prepare('UPDATE users SET text_playlist_api_key_hash = ? WHERE id = ?').run(hash, req.user.id);
    res.json({ success: true, api_key: apiKey, message: 'Text Playlist API key generated. Copy it now; MILO will not display it again.' });
});

app.delete('/api/user/text-playlist/api-key', requireLogin, (req, res) => {
    db.prepare('UPDATE users SET text_playlist_api_key_hash = NULL WHERE id = ?').run(req.user.id);
    res.json({ success: true, message: 'Text Playlist API key revoked.' });
});

function handleTextPlaylistIntegration(req, res, source = 'api') {
    const artist = String(req.body && req.body.artist || '').trim();
    const title = String(req.body && req.body.title || '').trim();
    if (!artist || !title) {
        return res.status(400).json({ success: false, message: 'Both artist and title are required.' });
    }
    if (artist.length > 300 || title.length > 300) {
        return res.status(400).json({ success: false, message: 'Artist and title must each be 300 characters or fewer.' });
    }
    const query = `${artist} - ${title}`;
    const result = appendTextPlaylistEntries(req.apiUser.id, [query], source);
    res.status(200).json({
        success: true,
        added: result.added > 0,
        message: result.added > 0 ? 'Track saved to your MILO Text Playlist.' : 'Track is already in your MILO Text Playlist.',
        artist,
        title
    });
}

app.post('/api/integrations/text-playlist', requireTextPlaylistApiKey, handleTextPlaylistIntegration);

app.post('/api/integrations/shazam', requireTextPlaylistApiKey, (req, res) => handleTextPlaylistIntegration(req, res, 'shazam'));

app.get('/api/catalog', requireLogin, (req, res) => {
    const query = (req.query.q || '').trim().toLowerCase();
    const sortBy = req.query.sort || 'artist';
    const order = (req.query.order || 'asc').toUpperCase();
    const libraryFilter = req.query.library_filter || 'all';
    const pageParam = parseInt(req.query.page, 10) || 1;
    const limitParam = req.query.limit === 'all' ? 'all' : (parseInt(req.query.limit, 10) || 50);
    const validSorts = { title: 'title', artist: 'artist', album: 'album', added: 'added_at' };
    const sortCol = validSorts[sortBy] || 'artist';
    const orderDir = order === 'DESC' ? 'DESC' : 'ASC';

    const liveSnapshot = getLiveCatalogSnapshot();
    const liveCatalogIds = liveSnapshot.ids;
    const totalCatalogCount = liveSnapshot.rows.length;
    const liveLibraryCount = db.prepare(`
        SELECT COUNT(*) AS total
        FROM user_tracks ut
        INNER JOIN live_catalog_ids live ON live.id = ut.track_id
        WHERE ut.user_id = ?
    `).get(req.user.id).total;

    if (libraryFilter === 'all' || libraryFilter === 'added') {
        scheduleLibraryLinkReconciliation(req.user.id, resolveUserLibraryPath(req.user), req.user.index_mode || 'standard', liveCatalogIds);
    }

    const conditions = [];
    const params = [];
    if (query) {
        conditions.push("c.search_str LIKE ?");
        params.push(`%${query.replace(/[^\w\s]/g, ' ').trim()}%`);
    }
    if (libraryFilter === 'added') {
        conditions.push('EXISTS (SELECT 1 FROM user_tracks ut WHERE ut.track_id = c.id AND ut.user_id = ?)');
        params.push(req.user.id);
    } else if (libraryFilter === 'unadded') {
        conditions.push('NOT EXISTS (SELECT 1 FROM user_tracks ut WHERE ut.track_id = c.id AND ut.user_id = ?)');
        params.push(req.user.id);
    }

    const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const fromClause = ' FROM catalog c INNER JOIN live_catalog_ids live ON live.id = c.id';
    const filteredCount = db.prepare(`SELECT COUNT(*) AS total${fromClause}${whereClause}`).get(...params).total;
    const totalPages = limitParam === 'all' ? 1 : (Math.ceil(filteredCount / Math.max(1, limitParam)) || 1);
    const pageNum = limitParam === 'all' ? 1 : Math.min(Math.max(1, pageParam), totalPages);
    const selectQuery = `
        SELECT c.id, c.title, c.artist, c.album, c.added_at, c.file_path,
            EXISTS (SELECT 1 FROM user_tracks selected WHERE selected.user_id = ? AND selected.track_id = c.id) AS in_library
        ${fromClause}${whereClause}
        ORDER BY c.${sortCol} ${orderDir}, c.id ${orderDir}
    `;
    const selectParams = [req.user.id, ...params];
    let visibleRows;
    let limitValue = limitParam;
    if (limitParam !== 'all') {
        limitValue = Math.max(1, limitParam);
        visibleRows = db.prepare(`${selectQuery} LIMIT ? OFFSET ?`).all(...selectParams, limitValue, (pageNum - 1) * limitValue);
    } else {
        visibleRows = db.prepare(selectQuery).all(...selectParams);
    }

    const durationByPath = new Map();
    const filePaths = [...new Set(visibleRows.map(row => String(row.file_path || '')).filter(Boolean))];
    const normalizeCatalogPath = value => {
        const resolved = normalizeFilesystemPath(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    for (let i = 0; i < filePaths.length; i += 400) {
        const batch = filePaths.slice(i, i + 400);
        if (!batch.length) continue;

        const placeholders = batch.map(() => '?').join(', ');
        try {
            const metadataRows = organizer.db.prepare(`
                SELECT file_path, metadata_json FROM file_records
                WHERE source_type = 'pool' AND file_path IN (${placeholders})
            `).all(...batch);
            for (const metadataRow of metadataRows) {
                try {
                    const metadata = JSON.parse(metadataRow.metadata_json || '{}');
                    const duration = Number(metadata.duration);
                    if (Number.isFinite(duration) && duration > 0) {
                        durationByPath.set(normalizeCatalogPath(metadataRow.file_path), duration);
                    }
                } catch (_) {}
            }
        } catch (error) {

            console.warn(`[Catalog] Could not load cached track durations: ${error.message}`);
            break;
        }
    }

    const results = visibleRows.map(row => ({
        id: row.id,
        title: row.title,
        artist: row.artist,
        album: row.album,
        duration: durationByPath.get(normalizeCatalogPath(row.file_path)) || null,
        format: path.extname(row.file_path || '').slice(1).toUpperCase() || 'Unknown',
        in_library: !!row.in_library
    }));

    res.json({
        tracks: results,
        stats: {
            total: totalCatalogCount,
            library: liveLibraryCount,
            filtered: filteredCount,
            page: pageNum,
            limit: limitValue,
            totalPages
        }
    });
});

app.post('/api/user/toggle-track', requireLogin, (req, res) => {
    const trackId = Number.parseInt(req.body.track_id, 10);
    if (!Number.isSafeInteger(trackId) || trackId <= 0) {
        return res.status(400).json({ success: false, message: 'A valid track must be selected.' });
    }
    const assigned = !!db.prepare('SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?').get(req.user.id, trackId);
    try {
        let inLibrary;
        if (assigned) {
            removeTrackFromUserLibrary(req.user, trackId);
            inLibrary = false;
        } else {
            addTrackToUserLibrary(req.user, trackId);
            inLibrary = true;
        }
        return res.json({ success: true, track_id: trackId, in_library: inLibrary });
    } catch (error) {
        console.error(`[Library] Could not ${assigned ? 'remove' : 'add'} track ${trackId} for user ${req.user.id}: ${error.message}`);
        return res.status(400).json({ success: false, message: error.message || 'Could not update this library selection.' });
    }
});

const activeJobs = {};
const runningSyncUserIds = new Set();
let activeLibraryPathJob = { status: 'idle', task: '', progress: 0, total: 0, message: '', result: null };

function cleanupEmptyLibraryDirectories(linkPath, libraryRoot) {
    let currentDir = path.dirname(linkPath);
    const root = normalizeFilesystemPath(libraryRoot);
    while (currentDir && !sameResolvedPath(currentDir, root) && pathSameOrInside(currentDir, root)) {
        try { fs.rmdirSync(currentDir); currentDir = path.dirname(currentDir); }
        catch (_) { break; }
    }
}

function removeManagedLibraryLink(libraryRoot, poolFilePath) {
    const target = libraryLinkPathForPoolFile(libraryRoot, poolFilePath);
    if (pathEntryExists(target) && (sameFileOnDisk(target, poolFilePath) || isBrokenPoolSymlink(target))) {
        removeExistingFileOrLink(target);
        cleanupEmptyLibraryDirectories(target, libraryRoot);
        return true;
    }
    return false;
}

async function runLibraryPathMigration(job) {
    const createdLinks = [];
    let moved = 0;
    let skipped = 0;
    try {
        const target = db.prepare('SELECT * FROM users WHERE id = ?').get(job.targetUserId);
        if (!target) throw new Error('The user no longer exists.');
        const oldRoot = resolveUserLibraryPath(target);
        const newRoot = job.newPath;
        const tracks = db.prepare(`SELECT c.id, c.file_path FROM user_tracks ut JOIN catalog c ON c.id = ut.track_id WHERE ut.user_id = ? ORDER BY c.id`).all(target.id);
        job.total = tracks.length;
        job.message = `Preparing ${tracks.length.toLocaleString()} assigned track link(s) in the new library folder...`;
        fs.mkdirSync(newRoot, { recursive: true });
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            job.message = `Moving assigned library links: ${i + 1} / ${tracks.length}`;
            try {
                if (!fs.existsSync(track.file_path)) { skipped++; }
                else {
                    const destination = libraryLinkPathForPoolFile(newRoot, track.file_path);
                    fs.mkdirSync(path.dirname(destination), { recursive: true });
                    if (pathEntryExists(destination)) {
                        if (sameFileOnDisk(destination, track.file_path)) {

                        } else if (isBrokenPoolSymlink(destination)) {
                            removeExistingFileOrLink(destination);
                            linkFile(track.file_path, destination, job.newMode);
                            createdLinks.push({ destination, root: newRoot });
                        } else {
                            throw new Error(`A different file already exists at ${destination}; it was left untouched.`);
                        }
                    } else {
                        linkFile(track.file_path, destination, job.newMode);
                        createdLinks.push({ destination, root: newRoot });
                    }
                    if (!sameFileOnDisk(destination, track.file_path)) throw new Error(`Could not verify the new link at ${destination}.`);
                    moved++;
                }
            } catch (error) {
                error.trackId = track.id;
                throw error;
            }
            job.progress = i + 1;
            if (i % 30 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        db.prepare(`UPDATE users SET username = ?, password_hash = ?, library_path = ?, index_mode = ?, role = ? WHERE id = ?`)
            .run(job.username, job.passwordHash, newRoot, job.newMode, job.newRole, target.id);
        for (const track of tracks) removeManagedLibraryLink(oldRoot, track.file_path);
        job.status = 'completed';
        job.completedAt = Date.now();
        job.progress = tracks.length;
        job.message = `Library path updated. ${moved.toLocaleString()} link(s) moved${skipped ? `; ${skipped} catalog file(s) were missing and could not be linked` : ''}.`;
        job.result = { moved, skipped, failed: 0 };
    } catch (error) {
        for (const item of createdLinks) {
            try { removeExistingFileOrLink(item.destination); cleanupEmptyLibraryDirectories(item.destination, item.root); } catch (_) {}
        }
        job.status = 'error';
        job.completedAt = Date.now();
        job.message = error.message || 'Could not move the user library to the new path.';
        job.errorTrace = error.stack || error.message;
        job.result = { moved: 0, failed: 1, track_id: error.trackId || null };
    }
    persistStandaloneTaskHistory(job);
}

async function runUserDeletionJob(job) {
    try {
        const target = db.prepare('SELECT * FROM users WHERE id = ?').get(job.targetUserId);
        if (!target) throw new Error('User not found.');
        const libraryRoot = resolveUserLibraryPath(target);
        const tracks = db.prepare(`SELECT c.id, c.file_path FROM user_tracks ut JOIN catalog c ON c.id = ut.track_id WHERE ut.user_id = ? ORDER BY c.id`).all(target.id);
        job.total = tracks.length;
        let removed = 0;
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            job.message = `Removing managed links for deleted user: ${i + 1} / ${tracks.length}`;
            if (removeManagedLibraryLink(libraryRoot, track.file_path)) removed++;
            job.progress = i + 1;
            if (i % 30 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        db.transaction(() => {
            db.prepare('DELETE FROM user_tracks WHERE user_id = ?').run(target.id);
            db.prepare('DELETE FROM missing_track_logs WHERE user_id = ?').run(target.id);
            db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
        })();
        historyDb.prepare('DELETE FROM removed_history WHERE user_id = ?').run(target.id);
        historyDb.prepare('DELETE FROM missing_log_history WHERE user_id = ?').run(target.id);
        job.status = 'completed';
        job.completedAt = Date.now();
        job.progress = tracks.length;
        queueWantedTracksRefresh('user deletion');
        job.message = `User deleted. Removed ${removed.toLocaleString()} managed link(s); unrelated files were left untouched.`;
        job.result = { removed, total: tracks.length };
    } catch (error) {
        job.status = 'error';
        job.completedAt = Date.now();
        job.message = error.message || 'Could not delete the user and clean up their links.';
        job.result = { failed: 1 };
    }
}

function isSyncJobInProgress(job) {
    return !!job && ['fetching', 'processing'].includes(job.status);
}

function hasActiveSyncJobs() {

    return runningSyncUserIds.size > 0 || Object.values(activeJobs).some(isSyncJobInProgress);
}

function hasCatalogMaintenanceInProgress() {
    return activeScanJob.status === 'running' || activeScanJob.status === 'fetching'
        || activeOrganizerJob.status === 'running' || organizer.running;
}

const queuedWorkTasks = new Map();
const queuedWorkOrder = [];
let activeQueueTaskId = null;
let queueDispatcherRunning = false;

function isQueueTaskPending(task) {
    return !!task && ['queued', 'running'].includes(task.status);
}

function getActiveQueueTask() {
    return activeQueueTaskId ? queuedWorkTasks.get(activeQueueTaskId) || null : null;
}

function getStandaloneQueueBlocker() {

    if (getActiveQueueTask()) return null;
    const activeStates = ['running', 'fetching', 'processing'];
    if (activeOrganizerJob && activeStates.includes(activeOrganizerJob.status)) {
        return {
            id: 'active-standalone-organizer', kind: 'maintenance', label: activeOrganizerJob.task === 'bulk-review' ? 'Organizer bulk review' : 'Organizer',
            status: 'running', progress: Number(activeOrganizerJob.progress) || 0, total: Number(activeOrganizerJob.total) || 0,
            message: activeOrganizerJob.message || 'Organizer maintenance is running.', createdAt: activeOrganizerJob.startedAt || Date.now()
        };
    }
    if (organizer.running) {
        return { id: 'active-standalone-organizer', kind: 'maintenance', label: 'Organizer', status: 'running', progress: 0, total: 0,
            message: 'Organizer maintenance is running.', createdAt: Date.now() };
    }
    if (activeDeadFileJob && activeStates.includes(activeDeadFileJob.status)) {
        return {
            id: 'active-standalone-dead-files', kind: 'maintenance', label: 'Dead Files', status: 'running',
            progress: Number(activeDeadFileJob.progress) || 0, total: Number(activeDeadFileJob.total) || 0,
            message: activeDeadFileJob.message || 'Dead Files maintenance is running.', createdAt: activeDeadFileJob.startedAt || Date.now()
        };
    }
    if (activeLibraryPathJob && activeStates.includes(activeLibraryPathJob.status)) {
        return {
            id: 'active-standalone-library-path', kind: 'maintenance', label: 'Library path update', status: 'running',
            progress: Number(activeLibraryPathJob.progress) || 0, total: Number(activeLibraryPathJob.total) || 0,
            message: activeLibraryPathJob.message || 'Library path maintenance is running.', createdAt: activeLibraryPathJob.startedAt || Date.now()
        };
    }
    return null;
}

function getQueueTaskPosition(taskId) {
    const active = getActiveQueueTask();
    if (active && active.id === taskId) return 1;
    const index = queuedWorkOrder.indexOf(taskId);
    if (index < 0) return null;
    const blockerOffset = active || getStandaloneQueueBlocker() ? 2 : 1;
    return index + blockerOffset;
}

function refreshQueuedWorkPositions() {
    queuedWorkOrder.forEach((taskId, index) => {
        const task = queuedWorkTasks.get(taskId);
        if (!task || task.status !== 'queued') return;
        const position = getQueueTaskPosition(taskId);
        task.position = position;
        task.message = `Waiting in queue — position ${position}.`;
        if (task.kind === 'sync') {
            const job = activeJobs[task.userId];
            if (job && job.queueId === task.id && job.status === 'queued') {
                job.message = task.message;
                job.queuePosition = position;
            }
        }
        if (task.kind === 'scan' && activeScanJob.queueId === task.id && activeScanJob.status === 'queued') {
            activeScanJob.message = task.message;
            activeScanJob.queuePosition = position;
        }
    });
}

function addQueuedWorkTask(details) {
    if (details.dedupeKey) {
        const existing = [...queuedWorkTasks.values()].find(task => task.dedupeKey === details.dedupeKey && isQueueTaskPending(task));
        if (existing) return { task: existing, existing: true };
    }

    const task = {
        id: crypto.randomUUID(),
        kind: details.kind,
        label: details.label || 'MILO task',
        userId: details.userId == null ? null : Number(details.userId),
        requestedByUserId: details.requestedByUserId == null ? null : Number(details.requestedByUserId),
        requestedByUsername: String(details.requestedByUsername || ''),
        scheduled: details.scheduled === true,
        dedupeKey: details.dedupeKey || '',
        priority: Number(details.priority) || 0,
        scanType: details.scanType || '',
        trigger: details.trigger || '',
        triggerSource: details.scheduled === true ? 'scheduled cron' : 'manual',
        username: String(details.username || details.payload?.user?.username || details.requestedByUsername || ''),
        payload: details.payload || null,
        status: 'queued',
        errorTrace: '',
        progress: 0,
        total: 0,
        message: 'Waiting in queue...',
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        result: null,
        error: null
    };
    queuedWorkTasks.set(task.id, task);
    saveBackgroundTaskHistory(task);
    queuedWorkOrder.push(task.id);
    queuedWorkOrder.sort((leftId, rightId) => {
        const left = queuedWorkTasks.get(leftId);
        const right = queuedWorkTasks.get(rightId);
        return (Number(right?.priority) || 0) - (Number(left?.priority) || 0)
            || (Number(left?.createdAt) || 0) - (Number(right?.createdAt) || 0);
    });
    refreshQueuedWorkPositions();
    setImmediate(() => drainQueuedWork().catch(error => console.error('[Queue] Dispatcher failed:', error.message)));
    return { task, existing: false };
}

function enqueueCatalogScan(scanType, trigger, options = {}) {
    const requestedType = scanType === 'full' ? 'full' : 'incremental';
    const isFull = requestedType === 'full';
    const label = options.label || (options.scheduled
        ? (isFull ? 'Scheduled full catalog + organizer scan' : 'Scheduled quick catalog scan')
        : (isFull ? 'Full catalog and organizer scan' : 'Quick catalog scan'));
    const currentActive = getActiveQueueTask();

    if (currentActive && currentActive.kind === 'scan') {
        if (currentActive.scanType === 'full' || requestedType === 'incremental') {

            if (options.scheduled !== true) currentActive.scheduled = false;
            saveBackgroundTaskHistory(currentActive);
            return { task: currentActive, existing: true, coveredByFull: currentActive.scanType === 'full' && !isFull };
        }
    }

    const pendingScan = queuedWorkOrder
        .map(taskId => queuedWorkTasks.get(taskId))
        .find(task => task && task.kind === 'scan' && task.status === 'queued');
    if (pendingScan) {
        if (options.scheduled !== true) pendingScan.scheduled = false;
        if (pendingScan.scanType === 'full' || requestedType === 'incremental') {
            saveBackgroundTaskHistory(pendingScan);
            return { task: pendingScan, existing: true, coveredByFull: pendingScan.scanType === 'full' && !isFull };
        }

        pendingScan.scanType = 'full';
        pendingScan.trigger = trigger;
        pendingScan.label = label;
        pendingScan.scheduled = pendingScan.scheduled && options.scheduled === true;
        pendingScan.priority = Math.max(Number(pendingScan.priority) || 0, Number(options.priority) || 0);
        pendingScan.message = 'Waiting in queue...';
        const pendingIndex = queuedWorkOrder.indexOf(pendingScan.id);
        if (pendingIndex >= 0) queuedWorkOrder.splice(pendingIndex, 1);
        queuedWorkOrder.push(pendingScan.id);
        queuedWorkOrder.sort((leftId, rightId) => {
            const left = queuedWorkTasks.get(leftId);
            const right = queuedWorkTasks.get(rightId);
            return (Number(right?.priority) || 0) - (Number(left?.priority) || 0)
                || (Number(left?.createdAt) || 0) - (Number(right?.createdAt) || 0);
        });
        if (activeScanJob.queueId === pendingScan.id) {
            activeScanJob.type = 'full';
            activeScanJob.trigger = trigger;
            activeScanJob.message = pendingScan.message;
        }
        refreshQueuedWorkPositions();
        saveBackgroundTaskHistory(pendingScan);
        return { task: pendingScan, existing: true, upgraded: true };
    }

    const queued = addQueuedWorkTask({
        kind: 'scan', scanType: requestedType, trigger, label,
        requestedByUserId: options.requestedByUserId,
        requestedByUsername: options.requestedByUsername,
        scheduled: options.scheduled === true,
        priority: Number(options.priority) || 0
    });
    if (!queued.existing && (!currentActive || currentActive.kind !== 'scan')) {
        activeScanJob = {
            status: 'queued', type: requestedType, trigger,
            queueId: queued.task.id, progress: 0, total: 0, message: queued.task.message,
            startedAt: queued.task.createdAt, dismissed: false
        };
    }
    return queued;
}

function enqueueUserSync(user, sourceType, inputData, options = {}, details = {}) {
    const userId = Number(user.id);
    const currentJob = activeJobs[userId];
    if (currentJob && !['error', 'completed', 'auto_completed', 'cancelled'].includes(currentJob.status)) {
        return { task: currentJob.queueId ? queuedWorkTasks.get(currentJob.queueId) : null, existing: true, userAlreadyBusy: true };
    }
    const isScheduled = details.scheduled === true;
    const label = details.label || (isScheduled
        ? `Scheduled sync${details.adminLabel ? ` — ${user.username || userId}` : ''}`
        : `${options.autoApply ? 'Sync Playlist' : 'Manual Import'} — ${sourceType}`);
    const queued = addQueuedWorkTask({
        kind: 'sync', label, userId, requestedByUserId: details.requestedByUserId == null ? userId : details.requestedByUserId,
        requestedByUsername: details.requestedByUsername || user.username || '', scheduled: isScheduled,
        dedupeKey: details.dedupeKey || '', priority: Number(details.priority) || 0,
        trigger: details.trigger || (isScheduled ? 'scheduled playlist sync' : 'manual playlist sync/import'),
        username: user.username || String(userId),
        payload: { user, sourceType, inputData, options: { autoApply: options.autoApply === true, includeTextPlaylist: options.includeTextPlaylist === true } }
    });
    if (queued.existing) return { ...queued, userAlreadyBusy: true };
    activeJobs[userId] = {
        status: 'queued', progress: 0, total: 0, result: null, error: null,
        context: options.autoApply ? 'auto' : 'manual', autoApplied: options.autoApply === true,
        applied: false, queueId: queued.task.id, queuePosition: getQueueTaskPosition(queued.task.id),
        message: queued.task.message, createdAt: queued.task.createdAt, startedAt: queued.task.createdAt,
        dismissed: false, scheduled: isScheduled
    };
    return queued;
}

function queueTaskIsBlockedByStandaloneWork() {
    return !!((activeOrganizerJob && ['running', 'fetching', 'processing'].includes(activeOrganizerJob.status)) || organizer.running
        || (activeDeadFileJob && activeDeadFileJob.status === 'running')
        || (activeLibraryPathJob && activeLibraryPathJob.status === 'running'));
}

function syncQueueTaskFromScan(task) {
    if (!task || task.kind !== 'scan') return;
    const scan = activeScanJob || {};
    task.scanType = scan.type || task.scanType;
    task.trigger = scan.trigger || task.trigger;
    task.progress = Number(scan.progress) || 0;
    task.total = Number(scan.total) || 0;
    task.message = scan.message || task.message;
    task.error = scan.status === 'error' ? scan.message : null;
    if (scan.status === 'error') task.errorTrace = scan.errorTrace || scan.message || '';
    task.result = scan.result || task.result;
    if (['completed', 'error', 'cancelled'].includes(scan.status)) task.status = scan.status;
    else if (['running', 'fetching', 'processing'].includes(scan.status)) task.status = 'running';
}

async function executeQueuedSyncTask(task) {
    const payload = task.payload || {};
    const user = payload.user;
    if (!user || !user.id) throw new Error('The queued sync no longer has a valid user.');
    const userId = Number(user.id);
    const job = activeJobs[userId];
    if (!job || job.queueId !== task.id) throw new Error('The queued sync was removed before it started.');
    job.status = 'fetching';
    job.startedAt = Date.now();
    job.message = `Starting ${task.label}...`;
    job.queuePosition = 1;
    task.status = 'running';
    task.startedAt = job.startedAt;
    task.message = job.message;
    runningSyncUserIds.add(userId);
    const mirror = setInterval(() => {
        const current = activeJobs[userId];
        if (!current || current.queueId !== task.id) return;
        task.status = ['fetching', 'processing'].includes(current.status) ? 'running' : current.status;
        task.progress = Number(current.progress) || 0;
        task.total = Number(current.total) || 0;
        task.message = current.message || `${task.label} is running...`;
        task.error = current.error || null;
    }, 250);
    if (mirror.unref) mirror.unref();
    try {
        await processSyncJob(user, payload.sourceType, payload.inputData, payload.options || {});
        task.status = job.status;
        task.result = job.result || null;
        task.error = job.error || null;
        if (job.status === 'error') task.errorTrace = job.errorTrace || job.error || job.message || '';
        task.message = job.message || (job.status === 'auto_completed' ? 'Sync completed and changes were applied.' : 'Import results are ready for review.');
    } catch (error) {
        job.status = 'error';
        job.error = error.message;
        job.errorTrace = error.stack || error.message;
        job.message = error.message;
        job.completedAt = Date.now();
        job.applied = false;
        task.status = 'error';
        task.error = error.message;
        task.errorTrace = error.stack || error.message;
        task.message = error.message;
    } finally {
        clearInterval(mirror);
        task.progress = Number(job.progress) || task.progress || 0;
        task.total = Number(job.total) || task.total || 0;
        task.completedAt = Date.now();
        try {
            const completedAt = Date.now() / 1000;
            db.transaction(() => {
                db.prepare('UPDATE users SET last_sync = ? WHERE id = ?').run(completedAt, userId);
                db.prepare("INSERT OR REPLACE INTO scan_settings (key, value) VALUES ('last_sync_job_completed', ?)").run(String(completedAt));
            })();
        } catch (completionError) {
            console.warn('[Scheduler] Could not record sync completion time:', completionError.message);
        }
        runningSyncUserIds.delete(userId);
    }
}

async function executeQueuedScanTask(task) {

    activeScanJob = {
        status: 'idle', type: task.scanType, trigger: task.trigger,
        progress: 0, total: 0, message: '', queueId: task.id,
        startedAt: task.startedAt || Date.now(), dismissed: false
    };
    const mirror = setInterval(() => syncQueueTaskFromScan(task), 250);
    if (mirror.unref) mirror.unref();
    try {
        if (task.scanType === 'full') await executeMasterPoolScan(task.trigger);
        else await executeIncrementalPoolScan(task.trigger);
        syncQueueTaskFromScan(task);
        if (!['completed', 'error'].includes(task.status)) task.status = 'completed';
    } catch (error) {
        task.status = 'error';
        task.error = error.message;
        task.errorTrace = error.stack || error.message;
        task.message = error.message;
        if (!['completed', 'error'].includes(activeScanJob.status)) {
            activeScanJob = {
                status: 'error', type: task.scanType, trigger: task.trigger,
                progress: task.progress || 0, total: task.total || 0,
                message: error.message, errorTrace: error.stack || error.message, queueId: task.id,
                startedAt: task.startedAt || Date.now(), completedAt: Date.now(), dismissed: false
            };
        }
    } finally {
        clearInterval(mirror);
        syncQueueTaskFromScan(task);
        if (task.status === 'error' && !task.errorTrace) task.errorTrace = activeScanJob.errorTrace || task.error || task.message || '';
        if (task.status === 'running' || task.status === 'queued') task.status = activeScanJob.status === 'error' ? 'error' : 'completed';
        task.completedAt = Date.now();
    }
}

async function drainQueuedWork() {
    if (queueDispatcherRunning || queueTaskIsBlockedByStandaloneWork()) return;
    queueDispatcherRunning = true;
    try {
        while (queuedWorkOrder.length) {
            if (queueTaskIsBlockedByStandaloneWork()) break;
            const taskId = queuedWorkOrder.shift();
            const task = queuedWorkTasks.get(taskId);
            if (!task || task.status !== 'queued') continue;
            activeQueueTaskId = task.id;
            task.status = 'running';
            task.startedAt = Date.now();
            task.position = 1;
            task.message = `Starting ${task.label}...`;
            saveBackgroundTaskHistory(task);
            if (task.kind === 'sync') {
                const job = activeJobs[task.userId];
                if (job && job.queueId === task.id) {
                    job.status = 'fetching';
                    job.startedAt = task.startedAt;
                    job.message = task.message;
                    job.queuePosition = 1;
                }
            }
            refreshQueuedWorkPositions();
            try {
                if (task.kind === 'sync') await executeQueuedSyncTask(task);
                else if (task.kind === 'scan') await executeQueuedScanTask(task);
                else throw new Error(`Unsupported queued task type: ${task.kind}`);
            } catch (error) {
                task.status = 'error';
                task.error = error.message;
                task.errorTrace = error.stack || error.message;
                task.message = error.message;
                task.completedAt = Date.now();
                console.error(`[Queue] ${task.label} failed:`, error.message);
            }
            if (task.status === 'running' || task.status === 'queued') task.status = 'completed';
            if (!task.completedAt) task.completedAt = Date.now();
            saveBackgroundTaskHistory(task);
            if (task.kind === 'sync') {
                const job = activeJobs[task.userId];
                if (job && job.queueId === task.id) {
                    if (task.status === 'cancelled') job.status = 'cancelled';
                    if (task.status === 'error' && !job.error) job.error = task.error || task.message;
                    job.message = task.message || job.message;
                    job.completedAt = task.completedAt;
                }
            }
            activeQueueTaskId = null;
            refreshQueuedWorkPositions();
            pruneQueuedWorkHistory();
        }
    } finally {
        activeQueueTaskId = null;
        queueDispatcherRunning = false;
        refreshQueuedWorkPositions();
    }
}

function pruneQueuedWorkHistory() {
    const terminal = [...queuedWorkTasks.values()]
        .filter(task => !isQueueTaskPending(task))
        .sort((a, b) => (Number(b.completedAt) || Number(b.createdAt) || 0) - (Number(a.completedAt) || Number(a.createdAt) || 0));
    for (const task of terminal.slice(150)) queuedWorkTasks.delete(task.id);
}

const queuedWorkRetryTimer = setInterval(() => {
    if (queuedWorkOrder.length && !queueDispatcherRunning) {
        drainQueuedWork().catch(error => console.error('[Queue] Dispatcher retry failed:', error.message));
    }
}, 1000);
if (queuedWorkRetryTimer.unref) queuedWorkRetryTimer.unref();

function queueTaskOwnedByViewer(task, viewer) {
    if (!task || !viewer || viewer.id == null) return false;
    const viewerId = Number(viewer.id);

    return (task.requestedByUserId != null && Number(task.requestedByUserId) === viewerId)
        || (task.kind === 'sync' && task.userId != null && Number(task.userId) === viewerId);
}

function queueTaskSnapshot(task, viewer, position = null) {
    const isAdmin = viewer && viewer.role === 'admin';
    const isOwner = queueTaskOwnedByViewer(task, viewer);
    return {
        id: task.id,
        kind: task.kind,
        type: task.kind === 'scan' ? task.scanType : task.kind,
        label: task.label,
        status: task.status,
        message: task.message || '',
        progress: Number(task.progress) || 0,
        total: Number(task.total) || 0,

        position: position != null ? position : getQueueTaskPosition(task.id),
        scheduled: !!task.scheduled,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        trigger: task.trigger || '',
        error: task.error || null,
        canCancel: task.status === 'queued' && (isAdmin || isOwner),
        ownedByViewer: !!isOwner
    };
}

function getQueueTasksForViewer(viewer) {
    refreshQueuedWorkPositions();
    const isAdmin = viewer && viewer.role === 'admin';
    const ordered = [];
    const standaloneBlocker = getStandaloneQueueBlocker();
    const active = getActiveQueueTask();

    if (isAdmin && standaloneBlocker) ordered.push(standaloneBlocker);
    if (active && active.status === 'running' && (isAdmin || queueTaskOwnedByViewer(active, viewer))) {
        ordered.push(active);
    }
    for (const taskId of queuedWorkOrder) {
        const task = queuedWorkTasks.get(taskId);
        if (!task || task.status !== 'queued') continue;
        if (isAdmin || queueTaskOwnedByViewer(task, viewer)) ordered.push(task);
    }
    return ordered.map(task => queueTaskSnapshot(task, viewer, getQueueTaskPosition(task.id)));
}

const POOL_STORAGE_CACHE_MS = 60 * 1000;
let poolStorageAnalysis = {
    status: 'idle', startedAt: null, calculatedAt: null, progress: 0, total: 0,
    phase: '', message: 'Storage analysis has not run yet.', totalBytes: 0,
    totalTracks: 0, missingMetadata: 0, errors: 0, formats: [], topArtists: [],
    userLinks: [], totalAssignedLinks: 0, validLinks: 0, brokenLinks: 0
};
let poolStorageAnalysisPromise = null;

function poolAudioFormatLabel(filePath, tags = {}) {
    const extension = path.extname(filePath || '').slice(1).toLowerCase();
    const codec = String(tags._codec || '').toLowerCase();
    const bitDepth = Number(tags._bits_per_sample || tags._bit_depth) || 0;
    if (extension === 'flac' || codec.includes('flac')) {
        return bitDepth === 24 ? 'FLAC 24-bit' : bitDepth === 16 ? 'FLAC 16-bit' : bitDepth ? `FLAC ${bitDepth}-bit` : 'FLAC (bit depth unknown)';
    }
    if (extension === 'm4a' && (codec.includes('alac') || /apple lossless/.test(codec))) return 'ALAC';
    if (extension === 'alac' || codec.includes('alac')) return 'ALAC';
    if (extension === 'mp3' || codec.includes('mpeg layer 3')) return 'MP3';
    if (extension === 'opus' || codec.includes('opus')) return 'Opus';
    if (extension === 'ogg' && (codec.includes('vorbis') || codec.includes('ogg'))) return codec.includes('vorbis') ? 'Ogg Vorbis' : 'OGG';
    if (extension === 'ogg') return 'OGG';
    if (extension === 'aac' || codec.includes('aac')) return 'AAC';
    if (extension === 'm4a') return 'M4A (codec unknown)';
    if (extension === 'wav' || codec.includes('pcm')) return 'WAV / PCM';
    if (extension === 'aiff' || extension === 'aif') return 'AIFF';
    if (extension === 'wma' || codec.includes('windows media')) return 'WMA';
    return extension ? extension.toUpperCase() : 'Unknown format';
}

function getUpcomingScheduledWork(nowMs = Date.now()) {
    const nowSeconds = nowMs / 1000;
    const readSetting = key => Number.parseFloat(db.prepare('SELECT value FROM scan_settings WHERE key = ?').get(key)?.value || 0) || 0;
    const upcoming = [];
    const masterInterval = normalizeIntervalToSchedule(readSetting('master_scan_interval'), MASTER_SCAN_SCHEDULES);
    const incrementalInterval = normalizeIntervalToSchedule(readSetting('incremental_scan_interval'), INCREMENTAL_SCAN_SCHEDULES);
    const lastFull = readSetting('last_master_scan');
    const lastQuick = readSetting('last_incremental_scan');
    if (masterInterval > 0) upcoming.push({
        id: 'scheduled-full-scan', type: 'scan', label: 'Detailed Full Scan + Organizer',
        intervalMinutes: masterInterval, lastRunAt: lastFull ? lastFull * 1000 : null,
        nextRunAt: Math.max(nowSeconds, lastFull > 0 ? lastFull + masterInterval * 60 : nowSeconds) * 1000,
        triggerSource: 'scheduled cron'
    });
    if (incrementalInterval > 0) upcoming.push({
        id: 'scheduled-quick-scan', type: 'scan', label: 'Quick Scan',
        intervalMinutes: incrementalInterval, lastRunAt: lastQuick ? lastQuick * 1000 : null,
        nextRunAt: Math.max(nowSeconds, lastQuick > 0 ? lastQuick + incrementalInterval * 60 : nowSeconds) * 1000,
        triggerSource: 'scheduled cron'
    });
    const users = db.prepare('SELECT id, username, auto_sync, sync_interval, last_sync, sync_provider, sync_url FROM users WHERE auto_sync = 1 AND sync_interval > 0').all();
    for (const user of users) {
        const interval = normalizeIntervalToSchedule(user.sync_interval, USER_SYNC_SCHEDULES);
        if (!interval) continue;
        const providerConfigured = ['spotify', 'youtube', 'apple'].includes(user.sync_provider) && String(user.sync_url || '').trim();
        const hasTextPlaylist = !!db.prepare('SELECT 1 FROM user_text_playlist WHERE user_id = ? LIMIT 1').get(user.id);
        if (!providerConfigured && !hasTextPlaylist) continue;
        const last = Number(user.last_sync) || 0;
        upcoming.push({
            id: `scheduled-sync-${user.id}`, type: 'sync', userId: Number(user.id),
            username: user.username, label: `Playlist Sync — ${user.username}`,
            intervalMinutes: interval, lastRunAt: last > 0 ? last * 1000 : null,
            nextRunAt: Math.max(nowSeconds, last > 0 ? last + interval * 60 : nowSeconds) * 1000,
            triggerSource: 'scheduled cron'
        });
    }
    return upcoming.sort((a, b) => a.nextRunAt - b.nextRunAt);
}

async function buildPoolStorageAnalysis() {
    const startedAt = Date.now();
    try {
        const poolRoot = normalizeFilesystemPath(MASTER_POOL_DIR);
        const exemptPaths = getExemptPaths();
        const catalogRows = db.prepare('SELECT id, file_path, title, artist, album FROM catalog ORDER BY id').all();
        const catalogByPath = new Map(catalogRows.map(row => [normalizedPathKey(row.file_path), row]));
        const liveTrackIds = new Set();
        const sizeByTrackId = new Map();
        const formats = new Map();
        const artists = new Map();
        const users = db.prepare('SELECT id, username, role, library_path, index_mode FROM users ORDER BY username COLLATE NOCASE').all();
        const linkStats = new Map(users.map(user => [Number(user.id), {
            userId: Number(user.id), username: user.username, role: user.role,
            indexMode: user.index_mode || 'standard', totalLinks: 0,
            validLinks: 0, brokenLinks: 0, assignedBytes: 0
        }]));
        let totalBytes = 0;
        let validTrackCount = 0;
        let missingMetadata = 0;
        let errors = 0;

        poolStorageAnalysis = {
            ...poolStorageAnalysis, status: 'building', startedAt, calculatedAt: null,
            progress: 0, total: 0, phase: 'enumerate', message: 'Enumerating audio files in the actual Master Pool…',
            totalBytes: 0, totalTracks: 0, missingMetadata: 0, errors: 0,
            formats: [], topArtists: [], userLinks: [], totalAssignedLinks: 0, validLinks: 0, brokenLinks: 0
        };
        const poolFiles = await walkDir(poolRoot, exemptPaths, progress => {
            poolStorageAnalysis.progress = Number(progress.discoveredAudioFiles) || 0;
            poolStorageAnalysis.message = `Enumerating Master Pool audio files… ${poolStorageAnalysis.progress.toLocaleString()} discovered`;
        });
        const uniquePoolFiles = [...new Map(poolFiles.map(file => [normalizedPathKey(file), normalizeFilesystemPath(file)])).values()];
        poolStorageAnalysis.phase = 'audio';
        poolStorageAnalysis.progress = 0;
        poolStorageAnalysis.total = uniquePoolFiles.length;
        poolStorageAnalysis.message = 'Measuring live audio files and reading codec, bitrate, bit-depth, and artist metadata…';

        const indexedOrganizerPaths = new Set(organizer.db.prepare("SELECT file_path FROM file_records WHERE source_type = 'pool'").all()
            .map(row => normalizedPathKey(row.file_path)));

        for (let i = 0; i < uniquePoolFiles.length; i++) {
            const sourcePath = uniquePoolFiles[i];
            try {
                const stat = await fs.promises.stat(sourcePath);
                if (!stat.isFile()) {
                    poolStorageAnalysis.progress = i + 1;
                    continue;
                }
                const key = normalizedPathKey(sourcePath);
                const catalogRow = catalogByPath.get(key) || null;
                let tags = {};
                try {
                    tags = indexedOrganizerPaths.has(key)
                        ? (await organizer.getEmbeddedMetadataForPath(sourcePath) || {})
                        : (await organizer.readTags(sourcePath) || {});
                } catch (_) { tags = {}; }
                if (!tags.title && !tags.artist && !tags._codec && !Number(tags.duration)) missingMetadata++;

                const label = poolAudioFormatLabel(sourcePath, tags);
                const bitrate = Number(tags._bitrate) > 0 ? Number(tags._bitrate)
                    : (Number(tags.duration) > 0 ? (stat.size * 8 / Number(tags.duration) / 1000) : 0);
                if (!formats.has(label)) formats.set(label, { name: label, trackCount: 0, bytes: 0, bitrateSum: 0, bitrateCount: 0 });
                const group = formats.get(label);
                group.trackCount++;
                group.bytes += stat.size;
                if (Number.isFinite(bitrate) && bitrate > 0) { group.bitrateSum += bitrate; group.bitrateCount++; }
                totalBytes += stat.size;
                validTrackCount++;

                if (catalogRow) {
                    liveTrackIds.add(Number(catalogRow.id));
                    sizeByTrackId.set(Number(catalogRow.id), stat.size);
                }
                const artistLabel = String(tags.albumartist || tags.artist || catalogRow?.artist || 'Unknown Artist').trim() || 'Unknown Artist';
                const artistKey = artistLabel.normalize('NFKC').toLocaleLowerCase();
                if (!artists.has(artistKey)) artists.set(artistKey, { artist: artistLabel, trackCount: 0, bytes: 0 });
                const artist = artists.get(artistKey);
                artist.trackCount++;
                artist.bytes += stat.size;
            } catch (error) {
                if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') errors++;
            }
            poolStorageAnalysis.progress = i + 1;
            if (i % 50 === 0) await new Promise(resolve => setImmediate(resolve));
        }

        poolStorageAnalysis.phase = 'links';
        poolStorageAnalysis.progress = 0;
        const linkRows = db.prepare(`SELECT ut.user_id, c.id AS track_id, c.file_path
            FROM user_tracks ut JOIN catalog c ON c.id = ut.track_id ORDER BY ut.user_id, c.id`).all();
        poolStorageAnalysis.total = linkRows.length;
        poolStorageAnalysis.message = 'Checking user-library link assignments against the current Master Pool files…';
        const userById = new Map(users.map(user => [Number(user.id), user]));
        for (let i = 0; i < linkRows.length; i++) {
            const row = linkRows[i];
            const stats = linkStats.get(Number(row.user_id));
            if (!stats) continue;
            stats.totalLinks++;
            try {
                const sourcePath = normalizeFilesystemPath(row.file_path);
                const sourceAvailable = liveTrackIds.has(Number(row.track_id)) && fs.existsSync(sourcePath);
                if (sourceAvailable) stats.assignedBytes += sizeByTrackId.get(Number(row.track_id)) || 0;
                const user = userById.get(Number(row.user_id));
                const targetPath = libraryLinkPathForPoolFile(user.library_path, sourcePath);
                if (sourceAvailable && pathEntryExists(targetPath) && sameFileOnDisk(targetPath, sourcePath)) stats.validLinks++;
                else stats.brokenLinks++;
            } catch (_) {
                stats.brokenLinks++;
            }
            poolStorageAnalysis.progress = i + 1;
            if (i % 250 === 0) await new Promise(resolve => setImmediate(resolve));
        }

        const formatRows = [...formats.values()].map(item => ({
            name: item.name, trackCount: item.trackCount, bytes: item.bytes,
            averageBitrateKbps: item.bitrateCount ? Math.round(item.bitrateSum / item.bitrateCount) : null,
            tracksWithBitrate: item.bitrateCount
        })).sort((a, b) => b.bytes - a.bytes);
        const artistRows = [...artists.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 10);
        const usersRows = [...linkStats.values()].sort((a, b) => b.totalLinks - a.totalLinks || a.username.localeCompare(b.username));
        const totals = usersRows.reduce((acc, user) => ({
            assigned: acc.assigned + user.totalLinks,
            valid: acc.valid + user.validLinks,
            broken: acc.broken + user.brokenLinks
        }), { assigned: 0, valid: 0, broken: 0 });
        poolStorageAnalysis = {
            status: 'ready', startedAt, calculatedAt: Date.now(), progress: linkRows.length,
            total: linkRows.length, phase: 'complete', message: `Measured ${validTrackCount.toLocaleString()} audio file(s) currently present in the Master Pool.`,
            totalBytes, totalTracks: validTrackCount, missingMetadata, errors,
            formats: formatRows, topArtists: artistRows, userLinks: usersRows,
            totalAssignedLinks: totals.assigned, validLinks: totals.valid, brokenLinks: totals.broken
        };
    } catch (error) {
        poolStorageAnalysis = {
            ...poolStorageAnalysis, status: 'error', calculatedAt: Date.now(),
            message: error.message || 'Storage analysis failed.', errorTrace: error.stack || error.message
        };
    } finally {
        poolStorageAnalysisPromise = null;
    }
}

function startPoolStorageAnalysis(force = false) {
    if (poolStorageAnalysisPromise) return;
    if (!force && poolStorageAnalysis.status === 'ready' && Date.now() - Number(poolStorageAnalysis.calculatedAt || 0) < POOL_STORAGE_CACHE_MS) return;
    poolStorageAnalysis = {
        ...poolStorageAnalysis, status: 'building', startedAt: Date.now(), calculatedAt: null,
        progress: 0, total: 0, phase: 'starting', message: 'Starting pool storage analysis…', errorTrace: ''
    };
    poolStorageAnalysisPromise = new Promise(resolve => setImmediate(resolve)).then(buildPoolStorageAnalysis);
}

function getBackgroundTaskHistory(limit = 75) {
    return db.prepare(`SELECT task_id AS id, kind, task_type AS type, label, user_id AS userId,
            username, requested_by AS requestedBy, trigger_source AS triggerSource,
            trigger_detail AS triggerDetail, status, created_at AS createdAt,
            started_at AS startedAt, completed_at AS completedAt, duration_ms AS durationMs,
            message, error_trace AS errorTrace, result_summary AS resultSummary
        FROM background_task_history WHERE status IN ('completed', 'error', 'cancelled')
        ORDER BY COALESCE(completed_at, created_at) DESC, created_at DESC LIMIT ?`).all(Math.max(1, Math.min(200, Number(limit) || 75)));
}

function getPoolMaintenanceActiveTasks(viewer) {
    const tasks = getQueueTasksForViewer(viewer);
    const queueIds = new Set(tasks.map(task => String(task.id)));
    const existingIds = new Set(tasks.map(task => String(task.id)));
    const addStandalone = (job, kind, label, uniqueKey = '') => {
        if (!job || !['running', 'fetching', 'queued'].includes(String(job.status || ''))) return;
        if (job.queueId && queueIds.has(String(job.queueId))) return;
        const id = String(job.historyTaskId || `${kind}:${uniqueKey || job.task || label}`);
        if (existingIds.has(id)) return;
        existingIds.add(id);
        tasks.push({
            id, kind, type: job.task || kind, label: label || job.historyLabel || job.task || kind,
            status: job.status, message: job.message || '',
            progress: Number(job.progress) || 0, total: Number(job.total) || 0,
            position: 0, createdAt: Number(job.historyCreatedAt || job.startedAt || job.createdAt) || Date.now(),
            startedAt: Number(job.startedAt) || null,
            triggerSource: job.scheduled ? 'scheduled cron' : 'manual',
            trigger: job.historyTriggerDetail || job.trigger || '',
            scheduled: job.scheduled === true
        });
    };

    addStandalone(activeScanJob, 'scan', activeScanJob.type === 'incremental' ? 'Quick Scan' : 'Detailed Full Scan');
    if (!activeOrganizerJob.nestedInScan) addStandalone(activeOrganizerJob, 'organizer', 'Organizer Processing');
    addStandalone(activeDeadFileJob, 'maintenance', activeDeadFileJob.historyLabel || 'Dead Files Maintenance');
    addStandalone(activeLibraryPathJob, 'maintenance', activeLibraryPathJob.historyLabel || 'User Library Maintenance');
    for (const [userId, job] of activeMissingLogJobs.entries()) {
        addStandalone(job, 'user-maintenance', job.historyLabel || `Unmatched Logs Batch — ${job.historyRequestedByUsername || `User ${userId}`}`, userId);
    }
    for (const [userId, job] of activeRestoreJobs.entries()) {
        addStandalone(job, 'user-maintenance', job.historyLabel || `Restore Tracks — ${job.historyRequestedByUsername || `User ${userId}`}`, userId);
    }
    return tasks.sort((a, b) => {
        const rank = status => status === 'running' ? 0 : status === 'fetching' ? 1 : 2;
        return rank(a.status) - rank(b.status) || Number(a.createdAt || 0) - Number(b.createdAt || 0);
    });
}

app.get('/api/admin/pool-maintenance/overview', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Administrator access required.' });
    res.set('Cache-Control', 'no-store');
    startPoolStorageAnalysis(req.query.refresh === '1');
    res.json({
        success: true,
        generatedAt: Date.now(),
        masterPoolPath: displayFilesystemPath(MASTER_POOL_DIR),
        activeTasks: getPoolMaintenanceActiveTasks(req.user),
        upcoming: getUpcomingScheduledWork(),
        history: getBackgroundTaskHistory(100),
        storage: poolStorageAnalysis
    });
});

app.get('/api/job-queue', requireLogin, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, tasks: getQueueTasksForViewer(req.user) });
});

app.get('/api/job-queue/:id', requireLogin, (req, res) => {
    const task = queuedWorkTasks.get(String(req.params.id || ''));
    if (!task) return res.status(404).json({ success: false, message: 'Queue task not found or its history has expired.' });

    if (req.user.role !== 'admin' && !queueTaskOwnedByViewer(task, req.user)) {
        return res.status(403).json({ success: false, message: 'You cannot view another user’s queued task.' });
    }
    const position = getQueueTaskPosition(task.id);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...queueTaskSnapshot(task, req.user, position), queueId: task.id, queueKind: task.kind });
});

app.post('/api/job-queue/:id/cancel', requireLogin, (req, res) => {
    const task = queuedWorkTasks.get(String(req.params.id || ''));
    if (!task) return res.status(404).json({ success: false, message: 'Queue task not found or its history has expired.' });

    if (req.user.role !== 'admin' && !queueTaskOwnedByViewer(task, req.user)) {
        return res.status(403).json({ success: false, message: 'You cannot remove another user’s queued task.' });
    }
    if (task.status !== 'queued') return res.status(409).json({ success: false, message: 'This task has already started and can no longer be removed from the queue.' });
    task.status = 'cancelled';
    task.completedAt = Date.now();
    task.message = 'Removed from the queue before it started.';
    task.error = null;
    task.errorTrace = '';
    saveBackgroundTaskHistory(task);
    const pendingIndex = queuedWorkOrder.indexOf(task.id);
    if (pendingIndex >= 0) queuedWorkOrder.splice(pendingIndex, 1);
    if (task.kind === 'sync') {
        const job = activeJobs[task.userId];
        if (job && job.queueId === task.id) {
            job.status = 'cancelled';
            job.message = task.message;
            job.completedAt = task.completedAt;
            job.error = null;
        }
    } else if (task.kind === 'scan' && activeScanJob.queueId === task.id) {
        activeScanJob = { status: 'cancelled', type: task.scanType, trigger: task.trigger, queueId: task.id,
            progress: 0, total: 0, message: task.message, startedAt: task.createdAt, completedAt: task.completedAt, dismissed: false };
    }
    refreshQueuedWorkPositions();
    res.json({ success: true, message: task.message });
});

app.post('/api/import/start-job', requireLogin, async (req, res) => {
    const currentJob = activeJobs[req.user.id];
    if (currentJob && !['error', 'completed', 'auto_completed', 'cancelled'].includes(currentJob.status)) {
        return res.status(409).json({ success: false, message: currentJob.status === 'queued' ? 'You already have a sync/import waiting in the queue.' : 'A sync/import for your account is already running.' });
    }

    let { source_type, input_data, save_to_text_playlist } = req.body;
    input_data = input_data == null ? '' : input_data;
    const isAutoRun = source_type === 'auto';
    let includeTextPlaylist = false;

    if (isAutoRun) {
        const providerIsConfigured = ['spotify', 'youtube', 'apple'].includes(req.user.sync_provider) && String(req.user.sync_url || '').trim();
        const hasSavedText = db.prepare('SELECT 1 FROM user_text_playlist WHERE user_id = ? LIMIT 1').get(req.user.id);
        if (providerIsConfigured) {
            source_type = req.user.sync_provider;
            input_data = req.user.sync_url;
            includeTextPlaylist = true;
        } else if (hasSavedText) {
            source_type = 'text_playlist';
            input_data = '';
        } else {
            return res.status(400).json({ success: false, message: 'Configure a provider playlist or add entries to your saved Text Playlist first.' });
        }
    }
    if (source_type !== 'text' && typeof input_data !== 'string') input_data = String(input_data || '');

    const validSources = ['text', 'text_playlist', 'spotify', 'youtube', 'apple'];
    if (!validSources.includes(source_type)) {
        return res.status(400).json({ success: false, message: `Unsupported import source: ${source_type || 'not selected'}` });
    }
    if (source_type === 'text' && typeof input_data !== 'string') {
        return res.status(400).json({ success: false, message: 'Manual import data must be plain text.' });
    }
    if (source_type === 'text' && !input_data.trim()) {
        return res.status(400).json({ success: false, message: 'Enter at least one track, with one entry per line.' });
    }
    if (['spotify', 'youtube', 'apple'].includes(source_type) && !String(input_data || '').trim()) {
        return res.status(400).json({ success: false, message: 'Enter a playlist URL or ID.' });
    }
    if (source_type === 'text_playlist' && !db.prepare('SELECT 1 FROM user_text_playlist WHERE user_id = ? LIMIT 1').get(req.user.id)) {
        return res.status(400).json({ success: false, message: 'Your saved Text Playlist is empty. Add entries in Sync Settings or through an external integration.' });
    }

    if (save_to_text_playlist && source_type === 'text') {
        appendTextPlaylistEntries(req.user.id, input_data, 'manual');
    }

    const queued = enqueueUserSync(req.user, source_type, input_data, {
        autoApply: isAutoRun && !!req.user.auto_sync,
        includeTextPlaylist
    }, {
        requestedByUserId: req.user.id,
        requestedByUsername: req.user.username,
        label: `${isAutoRun ? 'Sync Playlist' : 'Manual Import'} — ${source_type}`
    });
    if (queued.userAlreadyBusy) {
        return res.status(409).json({ success: false, message: 'A sync/import for your account is already queued or running.' });
    }
    const position = getQueueTaskPosition(queued.task.id);
    res.json({
        success: true,
        queued: queued.task.status === 'queued',
        queue_id: queued.task.id,
        position,
        message: queued.task.status === 'running'
            ? 'Sync/import started.'
            : `Added to the work queue at position ${position}. It will start automatically when earlier work finishes.`
    });
});

async function processSyncJob(user, source_type, input_data, options = {}) {
    const job = activeJobs[user.id];
    const autoApply = options.autoApply === true;
    if (job) job.autoApplied = autoApply;
    const includeTextPlaylist = options.includeTextPlaylist === true;
    const validSources = ['text', 'text_playlist', 'spotify', 'youtube', 'apple'];
    if (!validSources.includes(source_type)) {
        throw new Error(`Unsupported import source: ${source_type}`);
    }

    let raw_queries = [];
    let providerFetchWarning = '';
    try {
        if (source_type === 'text') {
            raw_queries = input_data.split(/\r?\n/).map(line => line.trim()).filter(line => line);
        } else if (source_type === 'text_playlist') {
            raw_queries = getTextPlaylistQueries(user.id);
        } else {
            raw_queries = await fetchProviderPlaylistTracks(source_type, input_data, {
                spotifyClientId: user.spotify_client_id || SPOTIPY_CLIENT_ID,
                spotifyClientSecret: user.spotify_client_secret || SPOTIPY_CLIENT_SECRET,
                appleDeveloperToken: user.apple_dev_token || APPLE_DEVELOPER_TOKEN
            });
        }
    } catch (sourceError) {
        const savedTextQueries = includeTextPlaylist ? getTextPlaylistQueries(user.id) : [];
        if (!includeTextPlaylist || savedTextQueries.length === 0) throw sourceError;
        providerFetchWarning = `Could not load the ${source_type} playlist (${sourceError.message}). MILO continued with this user's saved Text Playlist.`;
        raw_queries = [];
    }

    if (includeTextPlaylist && source_type !== 'text_playlist') {
        const seenQueries = new Set(raw_queries.map(normalizeTextPlaylistQuery).filter(Boolean));
        for (const query of getTextPlaylistQueries(user.id)) {
            const normalizedQuery = normalizeTextPlaylistQuery(query);
            if (normalizedQuery && !seenQueries.has(normalizedQuery)) {
                seenQueries.add(normalizedQuery);
                raw_queries.push(query);
            }
        }
    }

    job.status = 'processing';
    job.message = 'Matching playlist entries against the catalog...';
    job.total = raw_queries.length;

    const catalogRows = db.prepare(`SELECT id, title, artist, search_str FROM catalog`).all();
    const catalogMap = {};
    const catalogMapById = {};
    for (const r of catalogRows) {
        catalogMap[r.search_str] = r;
        catalogMapById[r.id] = r;
    }
    const catalogKeys = Object.keys(catalogMap);

    const userTrackRows = db.prepare(`SELECT track_id FROM user_tracks WHERE user_id = ?`).all(user.id);
    const userTracks = new Set(userTrackRows.map(r => r.track_id));

    const cacheRows = historyDb.prepare("SELECT raw_query, track_id FROM playlist_cache WHERE user_id = ? AND source_type = ?").all(user.id, source_type);
    const memoryCache = new Map();
    for (const c of cacheRows) {
        memoryCache.set(c.raw_query, c.track_id);
    }
    const missingSet = new Set();

    const matches_to_add = [], already_in_library = [], missing = [];

    const logMissing = db.transaction((q) => {
        const normalizedQuery = normalizeTextPlaylistQuery(q);
        if (!normalizedQuery) return;
        db.prepare(`INSERT INTO missing_track_logs (user_id, query, source, normalized_query, timestamp)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, normalized_query) DO UPDATE SET
                query = excluded.query, source = excluded.source, timestamp = CURRENT_TIMESTAMP`)
            .run(user.id, q, source_type, normalizedQuery);
    });

    const cacheInsert = historyDb.transaction((uid, src, rq, tid) => {
        historyDb.prepare(`INSERT OR REPLACE INTO playlist_cache (user_id, source_type, raw_query, track_id) VALUES (?, ?, ?, ?)`).run(uid, src, rq, tid);
    });

    for (let i = 0; i < raw_queries.length; i++) {
        job.progress = i + 1;
        if (job.queueId && queuedWorkTasks.has(job.queueId)) {
            const queueTask = queuedWorkTasks.get(job.queueId);
            queueTask.progress = job.progress;
            queueTask.total = job.total;
            queueTask.message = `Matching playlist entries: ${job.progress} / ${job.total}`;
        }
        const query = raw_queries[i];
        if (i % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        if (!query || typeof query !== 'string') continue;

        const clean_q = query.replace(/[^\w\s]/g, ' ').trim().toLowerCase();
        if (!clean_q || catalogKeys.length === 0) {
            missing.push({ query });
            logMissing(query);
            continue;
        }

        if (memoryCache.has(clean_q)) {
            const cachedTrackId = memoryCache.get(clean_q);
            if (cachedTrackId && catalogMapById[cachedTrackId]) {
                const rec = catalogMapById[cachedTrackId];
                const item = { track_id: rec.id, display: `${rec.artist} - ${rec.title}`, confidence: "100.0 (Cache)" };
                if (userTracks.has(rec.id)) {
                    already_in_library.push(item);
                    clearMissingTrackLogForQuery(user.id, query);
                } else {
                    matches_to_add.push(item);
                }
                continue;
            }
        }

        if (missingSet.has(clean_q)) {
            missing.push({ query });
            logMissing(query);
            continue;
        }

        const match = fuzz.extract(clean_q, catalogKeys, { scorer: fuzz.token_set_ratio, returnObjects: true, limit: 1 })[0];
        if (match && match.score >= 80) {
            const rec = catalogMap[match.choice];
            const item = { track_id: rec.id, display: `${rec.artist} - ${rec.title}`, confidence: match.score.toFixed(1) };
            if (userTracks.has(rec.id)) {
                already_in_library.push(item);
                clearMissingTrackLogForQuery(user.id, query);
            } else {
                matches_to_add.push(item);
            }

            memoryCache.set(clean_q, rec.id);
            cacheInsert(user.id, source_type, clean_q, rec.id);
        } else {
            missingSet.add(clean_q);
            missing.push({ query });
            logMissing(query);
        }
    }

    job.result = { matches: matches_to_add, exists: already_in_library, missing };
    if (providerFetchWarning) job.result.warnings = [providerFetchWarning];
    job.message = `Playlist matching complete: ${matches_to_add.length} to add, ${already_in_library.length} already in your library, ${missing.length} unmatched.`;

    if (autoApply) {
        let syncedCount = 0;
        let removedCount = 0;

        if (matches_to_add.length > 0) {
            const tids = matches_to_add.map(m => m.track_id);
            syncedCount = applyTracksToLibrary(user, tids);
        }

        if (user.one_for_one && (matches_to_add.length > 0 || already_in_library.length > 0)) {
            const keepTids = new Set([...matches_to_add.map(m => m.track_id), ...already_in_library.map(m => m.track_id)]);
            removedCount = removeUnmatchedTracks(user, keepTids, userTracks);
        }

        job.status = 'auto_completed';
        job.applied = true;
        job.result.added_count = syncedCount;
        job.result.removed_count = removedCount;
    } else {
        job.status = 'completed';
        job.applied = false;
    }
    job.completedAt = Date.now();
    queueWantedTracksRefresh('playlist sync');
}

function applyTracksToLibrary(user, trackIds) {
    let added = 0;
    const ids = Array.isArray(trackIds)
        ? [...new Set(trackIds.map(value => Number.parseInt(value, 10)).filter(value => Number.isSafeInteger(value) && value > 0))]
        : [];
    const failures = [];
    for (const trackId of ids) {
        try {
            const result = addTrackToUserLibrary(user, trackId);
            if (result.added) added++;
        } catch (error) {
            failures.push({ trackId, message: error.message });
        }
    }
    if (failures.length) {
        const first = failures[0];
        throw new Error(`Could not add ${failures.length} of ${ids.length} selected track(s). First failure: track ${first.trackId}: ${first.message}`);
    }
    return added;
}

function removeUnmatchedTracks(user, keepTids, userTracksSet) {
    let removed = 0;
    for (const trackId of userTracksSet) {
        if (keepTids.has(trackId)) continue;
        removeTrackFromUserLibrary(user, trackId);
        historyDb.prepare('INSERT INTO removed_history (user_id, track_id) VALUES (?, ?)').run(user.id, trackId);
        removed++;
    }
    return removed;
}

app.get('/api/import/status', requireLogin, (req, res) => {
    res.json(activeJobs[req.user.id] || { status: 'idle' });
});

app.post('/api/import/clear', requireLogin, (req, res) => {
    const job = activeJobs[req.user.id];
    if (job && ['queued', 'fetching', 'processing'].includes(job.status)) {
        return res.status(409).json({ success: false, message: job.status === 'queued'
            ? 'This sync/import is queued. Remove it from the Work Queue to cancel it.'
            : 'This sync/import is still running and cannot be dismissed yet.' });
    }
    delete activeJobs[req.user.id];
    res.json({ success: true });
});

app.get('/api/user/missing-logs', requireLogin, (req, res) => {
    try {

        const catalogRows = db.prepare('SELECT id, title, artist, search_str FROM catalog').all();
        const userTrackRows = db.prepare('SELECT track_id FROM user_tracks WHERE user_id = ?').all(req.user.id);
        const libraryTrackIds = new Set(userTrackRows.map(row => Number(row.track_id)));
        const exactLibraryQueries = new Map();
        for (const track of catalogRows) {
            if (!libraryTrackIds.has(Number(track.id))) continue;
            const exactQuery = normalizedTextTokenSet(`${track.artist || ''} ${track.title || ''}`);
            if (exactQuery && !exactLibraryQueries.has(exactQuery)) exactLibraryQueries.set(exactQuery, track);
        }
        if (exactLibraryQueries.size) {
            const existingLogs = db.prepare('SELECT id, query, source, normalized_query FROM missing_track_logs WHERE user_id = ?').all(req.user.id);
            const staleLogs = existingLogs.filter(log => String(log.source || '').toLowerCase() !== 'history'
                && exactLibraryQueries.has(normalizedTextTokenSet(log.normalized_query || log.query || '')));
            if (staleLogs.length) {
                const removeLog = db.prepare('DELETE FROM missing_track_logs WHERE id = ? AND user_id = ?');
                db.transaction(() => {
                    for (const log of staleLogs) {
                        const track = exactLibraryQueries.get(normalizedTextTokenSet(log.normalized_query || log.query || ''));
                        recordMissingLogHistory(req.user.id, log, 'skipped', track, true,
                            'Automatically cleared because an exact artist/title match was already assigned to this library.');
                        removeLog.run(log.id, req.user.id);
                    }
                })();
                queueWantedTracksRefresh('unmatched logs reconciled');
            }
        }

        const count = db.prepare('SELECT COUNT(*) AS total FROM missing_track_logs WHERE user_id = ?').get(req.user.id).total;
        const requestedLimit = Number.parseInt(req.query.limit, 10) || 50;
        const limit = Math.max(10, Math.min(100, requestedLimit));
        const pages = Math.max(1, Math.ceil(count / limit));
        const requestedPage = Number.parseInt(req.query.page, 10) || 1;
        const page = Math.max(1, Math.min(pages, requestedPage));
        const logs = db.prepare(`SELECT id, query, source, timestamp FROM missing_track_logs
            WHERE user_id = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`)
            .all(req.user.id, limit, (page - 1) * limit);
        const catalogKeys = catalogRows.map(row => row.search_str);
        const catalogMap = {};
        for (const row of catalogRows) catalogMap[row.search_str] = row;

        const enrichedLogs = logs.map(log => {
            const cleanQuery = normalizeTextPlaylistQuery(log.query);
            let suggestions = [];
            if (catalogKeys.length > 0 && cleanQuery) {
                suggestions = fuzz.extract(cleanQuery, catalogKeys, { scorer: fuzz.token_set_ratio, limit: 3 }).map(match => {
                    const track = catalogMap[match[0]];
                    return {
                        track_id: track.id, display: `${track.artist} - ${track.title}`, confidence: match[1],
                        in_library: libraryTrackIds.has(Number(track.id)),
                        exact_metadata_match: normalizedTextTokenSet(`${track.artist || ''} ${track.title || ''}`) === normalizedTextTokenSet(cleanQuery)
                    };
                });
            }
            return { ...log, suggestions };
        });
        res.json({ success: true, logs: enrichedLogs, count, page, pages, limit });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Could not load unmatched-track logs.' });
    }
});

async function runRestoreTracksJob(user, trackIds, job) {
    let restored = 0;
    let alreadyAssigned = 0;
    const errors = [];
    try {
        for (let i = 0; i < trackIds.length; i++) {
            const trackId = Number(trackIds[i]);
            job.message = `Restoring selected tracks: ${i + 1} / ${trackIds.length}`;
            try {
                const result = addTrackToUserLibrary(user, trackId);
                if (result.added) restored++;
                else alreadyAssigned++;
            } catch (error) {
                errors.push({ track_id: trackId, message: error.message || 'Could not restore this track.' });
            }
            job.progress = i + 1;
            if (i % 2 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        job.status = 'completed';
        job.completedAt = Date.now();
        job.progress = trackIds.length;
        job.total = trackIds.length;
        job.message = `Restore finished: ${restored} restored${alreadyAssigned ? `, ${alreadyAssigned} already assigned` : ''}${errors.length ? `, ${errors.length} need attention` : ''}.`;
        job.result = { restored, alreadyAssigned, failed: errors.length, errors: errors.slice(0, 100) };
    } catch (error) {
        job.status = 'error';
        job.completedAt = Date.now();
        job.message = error.message || 'Could not restore the selected tracks.';
        job.result = { restored, alreadyAssigned, failed: errors.length, errors: errors.slice(0, 100) };
    } finally {
        invalidateLiveCatalogSnapshot();
        lastLibraryLinkReconcileAt.delete(Number(user.id));
        if (errors.length) job.errorTrace = errors.map(item => `Track ${item.track_id}: ${item.message}`).join('\n');
        persistStandaloneTaskHistory(job);
    }
}

async function runMissingLogBulkJob(user, items, job) {
    const errors = [];
    let linked = 0;
    let added = 0;
    try {
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            job.message = `Linking selected unmatched tracks: ${i + 1} / ${items.length}`;
            try {
                const log = db.prepare('SELECT id, query, source FROM missing_track_logs WHERE id = ? AND user_id = ?')
                    .get(Number(item.log_id), Number(user.id));
                if (!log) throw new Error('This unmatched log no longer exists for the current user.');
                const track = db.prepare('SELECT id, title, artist FROM catalog WHERE id = ?').get(Number(item.track_id));
                if (!track) throw new Error('The selected catalog track no longer exists.');
                const alreadyAssigned = !!db.prepare('SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?').get(Number(user.id), Number(item.track_id));
                const result = addTrackToUserLibrary(user, item.track_id);
                const deletion = db.prepare('DELETE FROM missing_track_logs WHERE id = ? AND user_id = ?')
                    .run(Number(item.log_id), Number(user.id));
                if (!deletion.changes) throw new Error('The unmatched log was already cleared.');
                recordMissingLogHistory(user.id, log, 'linked', track, alreadyAssigned, result.added ? 'Track added to the library from an unmatched-log decision.' : 'The chosen track was already assigned to the library.');
                linked++;
                if (result.added) added++;
            } catch (error) {
                errors.push({ log_id: Number(item.log_id), track_id: Number(item.track_id), message: error.message });
            }
            job.progress = i + 1;
            if (i % 2 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        job.status = errors.length === items.length && errors.length ? 'error' : 'completed';
        job.completedAt = Date.now();
        job.progress = items.length;
        job.total = items.length;
        job.message = `Unmatched-log batch finished: ${linked} linked${errors.length ? `, ${errors.length} need attention` : ''}.`;
        job.errorTrace = errors.length ? errors.map(item => `Log ${item.log_id}, track ${item.track_id}: ${item.message}`).join('\n') : '';
        job.result = { linked, added, failed: errors.length, errors: errors.slice(0, 50) };
        queueWantedTracksRefresh('unmatched-log resolution');
    } catch (error) {
        job.status = 'error';
        job.completedAt = Date.now();
        job.message = error.message;
        job.errorTrace = error.stack || error.message;
        job.result = { linked, added, failed: errors.length, errors: errors.slice(0, 50) };
    }
    invalidateLiveCatalogSnapshot();
    lastLibraryLinkReconcileAt.clear();
    persistStandaloneTaskHistory(job);
}

async function runMissingLogSkipJob(userId, items, job) {
    let skipped = 0;
    const errors = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const logId = Number(item.log_id);
        job.message = `Skipping selected unmatched logs: ${i + 1} / ${items.length}`;
        try {
            const log = db.prepare('SELECT id, query, source FROM missing_track_logs WHERE id = ? AND user_id = ?').get(logId, userId);
            if (!log) throw new Error('This unmatched log no longer exists.');
            const trackId = Number.parseInt(item.track_id, 10) || 0;
            const track = trackId > 0 ? db.prepare('SELECT id, title, artist FROM catalog WHERE id = ?').get(trackId) : null;
            if (trackId > 0 && !track) throw new Error('The selected catalog track no longer exists.');
            const alreadyAssigned = !!(track && db.prepare('SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?').get(userId, track.id));
            recordMissingLogHistory(userId, log, 'skipped', track, alreadyAssigned,
                alreadyAssigned ? 'Skipped from active unmatched logs; the selected suggestion was already in the library.' : (track ? 'Skipped after reviewing the selected suggestion.' : 'Skipped without selecting a suggestion.'));
            db.prepare('DELETE FROM missing_track_logs WHERE id = ? AND user_id = ?').run(logId, userId);
            skipped++;
        } catch (error) { errors.push({ log_id: logId, message: error.message || 'Could not skip this log.' }); }
        job.progress = i + 1;
        if (i % 25 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    job.status = errors.length === items.length && errors.length ? 'error' : 'completed';
    job.completedAt = Date.now();
    job.progress = items.length;
    job.total = items.length;
    job.message = `Unmatched-log skip finished: ${skipped} skipped${errors.length ? `, ${errors.length} need attention` : ''}.`;
    job.errorTrace = errors.length ? errors.map(item => `Log ${item.log_id}: ${item.message}`).join('\n') : '';
    job.result = { skipped, failed: errors.length, errors: errors.slice(0, 100) };
    queueWantedTracksRefresh('unmatched-log skip');
    persistStandaloneTaskHistory(job);
}

app.post('/api/user/missing-logs/resolve/bulk', requireLogin, (req, res) => {
    const existingJob = activeMissingLogJobs.get(req.user.id);
    if (existingJob && existingJob.status === 'running') return res.status(409).json({ success: false, message: 'An unmatched-log batch is already running for this user.' });
    const incoming = Array.isArray(req.body.items) ? req.body.items : [];
    const seenLogIds = new Set();
    const items = [];
    for (const entry of incoming) {
        const logId = Number.parseInt(entry && entry.log_id, 10);
        const trackId = Number.parseInt(entry && entry.track_id, 10);
        if (!Number.isSafeInteger(logId) || logId <= 0 || !Number.isSafeInteger(trackId) || trackId <= 0 || seenLogIds.has(logId)) continue;
        seenLogIds.add(logId);
        items.push({ log_id: logId, track_id: trackId });
    }
    if (!items.length) return res.status(400).json({ success: false, message: 'Select one or more unmatched logs and choose a suggested track for each.' });
    if (items.length > 5000) return res.status(400).json({ success: false, message: 'A single unmatched-log batch is limited to 5,000 choices.' });
    const job = { status: 'running', task: 'missing-logs-bulk', progress: 0, total: items.length,
        message: `Starting unmatched-log batch (${items.length} choice${items.length === 1 ? '' : 's'})...`, result: null, startedAt: Date.now(), dismissed: false };
    startStandaloneTaskHistory(job, req.user, 'Unmatched Logs — Link Selected', 'Unmatched Logs bulk link');
    activeMissingLogJobs.set(req.user.id, job);
    const user = { id: req.user.id, username: req.user.username, library_path: req.user.library_path, index_mode: req.user.index_mode || 'standard' };
    res.json({ success: true, total: items.length, message: `Started linking ${items.length} selected unmatched track(s).` });
    setImmediate(() => runMissingLogBulkJob(user, items, job));
});

app.get('/api/user/missing-logs/resolve/bulk/status', requireLogin, (req, res) => {
    res.json(activeMissingLogJobs.get(req.user.id) || { status: 'idle', task: 'missing-logs-bulk', progress: 0, total: 0, message: '', result: null });
});

app.delete('/api/user/missing-logs/all', requireLogin, (req, res) => {
    db.prepare('DELETE FROM missing_track_logs WHERE user_id = ?').run(req.user.id);
    queueWantedTracksRefresh('unmatched logs cleared');
    res.json({ success: true });
});

app.post('/api/user/missing-logs/:log_id/skip', requireLogin, (req, res) => {
    const logId = Number.parseInt(req.params.log_id, 10);
    const log = db.prepare('SELECT id, query, source FROM missing_track_logs WHERE id = ? AND user_id = ?').get(logId, req.user.id);
    if (!log) return res.status(404).json({ success: false, message: 'This unmatched log no longer exists.' });
    const selectedTrackId = Number.parseInt(req.body.track_id, 10) || 0;
    const track = selectedTrackId > 0 ? db.prepare('SELECT id, title, artist FROM catalog WHERE id = ?').get(selectedTrackId) : null;
    const alreadyAssigned = !!(track && db.prepare('SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?').get(req.user.id, track.id));
    try {
        db.transaction(() => {
            recordMissingLogHistory(req.user.id, log, 'skipped', track, alreadyAssigned,
                alreadyAssigned ? 'Skipped from active unmatched logs; the suggested track was already in the library.' : 'Skipped from active unmatched logs.');
            db.prepare('DELETE FROM missing_track_logs WHERE id = ? AND user_id = ?').run(logId, req.user.id);
        })();
        queueWantedTracksRefresh('unmatched-log skip');
        res.json({ success: true, message: 'Unmatched log skipped and saved to history.' });
    } catch (error) { res.status(500).json({ success: false, message: error.message || 'Could not skip this unmatched log.' }); }
});

app.post('/api/user/missing-logs/skip/bulk', requireLogin, (req, res) => {
    const existingJob = activeMissingLogJobs.get(req.user.id);
    if (existingJob && existingJob.status === 'running') return res.status(409).json({ success: false, message: 'An unmatched-log batch is already running for this user.' });
    const incoming = Array.isArray(req.body.items) ? req.body.items : [];
    const seen = new Set();
    const items = [];
    for (const entry of incoming) {
        const logId = Number.parseInt(entry && entry.log_id, 10);
        const trackId = Number.parseInt(entry && entry.track_id, 10) || 0;
        if (!Number.isSafeInteger(logId) || logId <= 0 || trackId < 0 || seen.has(logId)) continue;
        seen.add(logId);
        items.push({ log_id: logId, track_id: trackId });
    }
    if (!items.length) return res.status(400).json({ success: false, message: 'Select one or more unmatched logs to skip.' });
    if (items.length > 5000) return res.status(400).json({ success: false, message: 'A single skip run is limited to 5,000 unmatched logs.' });
    const job = { status: 'running', task: 'missing-logs-bulk', action: 'skip', startedAt: Date.now(), dismissed: false, progress: 0, total: items.length,
        message: `Starting skip for ${items.length} unmatched log(s)...`, result: null };
    startStandaloneTaskHistory(job, req.user, 'Unmatched Logs — Skip Selected', 'Unmatched Logs bulk skip');
    activeMissingLogJobs.set(req.user.id, job);
    res.json({ success: true, total: items.length, message: `Started skipping ${items.length} unmatched log(s).` });
    setImmediate(() => runMissingLogSkipJob(req.user.id, items, job));
});

app.get('/api/user/missing-logs/history', requireLogin, (req, res) => {
    const limit = Math.max(10, Math.min(500, Number.parseInt(req.query.limit, 10) || 100));
    const rows = historyDb.prepare(`SELECT id, log_id, query, source, action, track_id, track_title, track_artist,
        already_assigned, details, created_at, undone_at FROM missing_log_history
        WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(req.user.id, limit);
    res.json({ success: true, entries: rows });
});

app.post('/api/user/missing-logs/history/:history_id/undo', requireLogin, (req, res) => {
    const historyId = Number.parseInt(req.params.history_id, 10);
    const history = historyDb.prepare('SELECT * FROM missing_log_history WHERE id = ? AND user_id = ?').get(historyId, req.user.id);
    if (!history) return res.status(404).json({ success: false, message: 'History entry not found.' });
    if (history.undone_at) return res.status(409).json({ success: false, message: 'This history entry has already been reversed.' });
    const normalizedQuery = normalizeTextPlaylistQuery(history.query);
    if (!normalizedQuery) return res.status(400).json({ success: false, message: 'This history entry does not contain a usable unmatched query.' });
    const existingLog = db.prepare('SELECT id FROM missing_track_logs WHERE user_id = ? AND normalized_query = ?').get(req.user.id, normalizedQuery);
    if (existingLog) return res.status(409).json({ success: false, message: 'This unmatched query is already in the active log list.' });
    try {
        if (history.action === 'linked' && !history.already_assigned && history.track_id) {
            const stillAssigned = db.prepare('SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?').get(req.user.id, history.track_id);
            if (stillAssigned) removeTrackFromUserLibrary(req.user, history.track_id);
        }
        restoreMissingLogFromHistory(history);
        historyDb.prepare('UPDATE missing_log_history SET undone_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(historyId, req.user.id);
        queueWantedTracksRefresh('unmatched-log restored');
        invalidateLiveCatalogSnapshot();
        lastLibraryLinkReconcileAt.delete(Number(req.user.id));
        res.json({ success: true, message: 'History entry reversed; the unmatched query is back in the active log list.' });
    } catch (error) { res.status(400).json({ success: false, message: error.message || 'Could not reverse this history entry.' }); }
});

app.delete('/api/user/missing-logs/:log_id', requireLogin, (req, res) => {
    const result = db.prepare('DELETE FROM missing_track_logs WHERE id = ? AND user_id = ?').run(req.params.log_id, req.user.id);
    if (result.changes) queueWantedTracksRefresh('unmatched log removed');
    res.json({ success: true, cleared: result.changes > 0 });
});

app.post('/api/user/missing-logs/resolve', requireLogin, (req, res) => {
    const logId = Number.parseInt(req.body.log_id, 10);
    const trackId = Number.parseInt(req.body.track_id, 10);
    const log = db.prepare('SELECT id, query, source FROM missing_track_logs WHERE id = ? AND user_id = ?').get(logId, req.user.id);
    if (!log) return res.status(404).json({ success: false, message: 'This unmatched log no longer exists.' });
    try {
        const track = db.prepare('SELECT id, title, artist FROM catalog WHERE id = ?').get(trackId);
        if (!track) throw new Error('The selected catalog track no longer exists.');
        const alreadyAssigned = !!db.prepare('SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?').get(req.user.id, trackId);
        const result = addTrackToUserLibrary(req.user, trackId);
        const deletion = db.prepare('DELETE FROM missing_track_logs WHERE id = ? AND user_id = ?').run(logId, req.user.id);
        if (!deletion.changes) return res.status(409).json({ success: false, message: 'The unmatched log was already cleared.' });
        recordMissingLogHistory(req.user.id, log, 'linked', track, alreadyAssigned, result.added ? 'Track added to the library from an unmatched-log decision.' : 'The chosen track was already assigned to the library.');
        queueWantedTracksRefresh('unmatched-log resolution');
        return res.json({ success: true, added: result.added, message: result.added ? 'Track linked to your library.' : 'Track was already in your library; unmatched log cleared.' });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message || 'Could not link this unmatched track.' });
    }
});

app.get('/api/user/removed-logs', requireLogin, (req, res) => {
    const logs = historyDb.prepare(`SELECT id, track_id, removed_at FROM removed_history WHERE user_id = ? ORDER BY removed_at DESC LIMIT 100`).all(req.user.id);
    const results = [];
    const getTrack = db.prepare(`SELECT title, artist FROM catalog WHERE id = ?`);
    for (const log of logs) {
        const track = getTrack.get(log.track_id);
        if (track) {
            results.push({ log_id: log.id, track_id: log.track_id, title: track.title, artist: track.artist, removed_at: log.removed_at });
        }
    }
    res.json(results);
});

app.post('/api/user/removed-logs/restore', requireLogin, (req, res) => {
    const existingJob = activeRestoreJobs.get(req.user.id);
    if (existingJob && existingJob.status === 'running') {
        return res.status(409).json({ success: false, message: 'A Restore Tracks task is already running for this user.' });
    }
    const incoming = Array.isArray(req.body.track_ids) ? req.body.track_ids : [];
    const trackIds = [...new Set(incoming.map(value => Number.parseInt(value, 10))
        .filter(value => Number.isSafeInteger(value) && value > 0))];
    if (!trackIds.length) return res.status(400).json({ success: false, message: 'Select one or more removed tracks first.' });
    if (trackIds.length > 5000) return res.status(400).json({ success: false, message: 'A single Restore Tracks run is limited to 5,000 tracks.' });
    const job = { status: 'running', task: 'restore-tracks-bulk', progress: 0, total: trackIds.length,
        message: `Starting restore for ${trackIds.length} selected track${trackIds.length === 1 ? '' : 's'}...`, result: null, startedAt: Date.now(), dismissed: false };
    startStandaloneTaskHistory(job, req.user, 'Restore Tracks — Bulk Restore', 'Restore Tracks bulk restore');
    activeRestoreJobs.set(req.user.id, job);
    const user = { id: req.user.id, username: req.user.username, library_path: req.user.library_path, index_mode: req.user.index_mode || 'standard' };
    res.json({ success: true, total: trackIds.length, message: `Started restoring ${trackIds.length} selected track${trackIds.length === 1 ? '' : 's'}.` });
    setImmediate(() => runRestoreTracksJob(user, trackIds, job));
});

app.get('/api/user/removed-logs/restore/status', requireLogin, (req, res) => {
    res.json(activeRestoreJobs.get(req.user.id) || { status: 'idle', task: 'restore-tracks-bulk', progress: 0, total: 0, message: '', result: null });
});

app.post('/api/import/confirm', requireLogin, (req, res) => {
    const trackIds = Array.isArray(req.body.track_ids)
        ? [...new Set(req.body.track_ids.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0))]
        : [];
    const existingIds = Array.isArray(req.body.existing_ids)
        ? [...new Set(req.body.existing_ids.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0))]
        : [];
    const keepTids = new Set([...trackIds, ...existingIds]);
    try {
        const added = applyTracksToLibrary(req.user, trackIds);
        let removed = 0;

        if (req.user.one_for_one && keepTids.size > 0) {
            const userTrackRows = db.prepare(`SELECT track_id FROM user_tracks WHERE user_id = ?`).all(req.user.id);
            const userTracks = new Set(userTrackRows.map(r => r.track_id));
            removed = removeUnmatchedTracks(req.user, keepTids, userTracks);
        }

        return res.json({ success: true, message: `Synced successfully. Added ${added} track(s)${removed ? ` and removed ${removed} no-longer-matching track(s)` : ''}.`, added, removed });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message || 'Could not apply the selected import.' });
    }
});

app.route('/')
    .get((req, res) => {
        const messages = req.session.messages || [];
        req.session.messages = [];
        if (!req.session.userId) return res.render('index', { mode: 'login', current_user: null, messages });
        const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.session.userId);
        res.render('index', { mode: 'dashboard', current_user: user, messages });
    })
    .post((req, res) => {
        const { username, password } = req.body;
        const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
        if (user && bcrypt.compareSync(password, user.password_hash)) {
            req.session.userId = user.id;
            return res.redirect('/');
        }
        req.session.messages = ["Invalid credentials"];
        res.redirect('/');
    });

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, message: "Request size exceeds 50 MB." });
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return res.status(400).json({ success: false, message: "Invalid JSON request." });
    console.error("Unhandled server error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
});

let schedulerTickRunning = false;

function runBackgroundScheduler(activeProtocol = 'http') {

    setInterval(async () => {
        if (schedulerTickRunning) return;
        schedulerTickRunning = true;

        try {
            const now = Date.now() / 1000;
            const masterIntervalRow = db.prepare("SELECT value FROM scan_settings WHERE key = 'master_scan_interval'").get();
            const lastMasterScanRow = db.prepare("SELECT value FROM scan_settings WHERE key = 'last_master_scan'").get();
            const masterIntervalMinutes = normalizeIntervalToSchedule(masterIntervalRow?.value || 0, MASTER_SCAN_SCHEDULES);
            const masterIntervalSeconds = masterIntervalMinutes * 60;
            const lastMasterScan = parseFloat(lastMasterScanRow?.value || 0);
            const masterScanDue = masterIntervalSeconds > 0 && (now - lastMasterScan >= masterIntervalSeconds);
            const incrementalIntervalRow = db.prepare("SELECT value FROM scan_settings WHERE key = 'incremental_scan_interval'").get();
            const lastIncrementalRow = db.prepare("SELECT value FROM scan_settings WHERE key = 'last_incremental_scan'").get();
            const incrementalIntervalMinutes = normalizeIntervalToSchedule(incrementalIntervalRow?.value || 0, INCREMENTAL_SCAN_SCHEDULES);
            const lastIncrementalScan = Number.parseFloat(lastIncrementalRow?.value || 0);
            const incrementalScanDue = incrementalIntervalMinutes > 0 && (now - lastIncrementalScan >= incrementalIntervalMinutes * 60);

            const scanActive = activeScanJob.status === 'running' || activeScanJob.status === 'fetching';
            const organizerActive = activeOrganizerJob.status === 'running' || organizer.running;

            if (masterScanDue) {
                const existingFullScan = [...queuedWorkTasks.values()].find(task => task.kind === 'scan' && task.scanType === 'full' && isQueueTaskPending(task));
                if (existingFullScan) {
                    if (existingFullScan.status === 'queued' && existingFullScan.priority < 100) {
                        existingFullScan.priority = 100;
                        queuedWorkOrder.sort((leftId, rightId) => {
                            const left = queuedWorkTasks.get(leftId);
                            const right = queuedWorkTasks.get(rightId);
                            return (Number(right?.priority) || 0) - (Number(left?.priority) || 0)
                                || (Number(left?.createdAt) || 0) - (Number(right?.createdAt) || 0);
                        });
                        refreshQueuedWorkPositions();
                    }
                } else {
                    enqueueCatalogScan('full', 'scheduled full catalog and organizer scan', {
                        scheduled: true, priority: 100
                    });
                }
                return;
            }

            if (incrementalScanDue) {
                const fullScanAlreadyCoversQuickScan = [...queuedWorkTasks.values()].some(task => task.kind === 'scan' && task.scanType === 'full' && isQueueTaskPending(task));
                const existingQuickScan = [...queuedWorkTasks.values()].find(task => task.kind === 'scan' && task.scanType === 'incremental' && isQueueTaskPending(task));
                if (!fullScanAlreadyCoversQuickScan && !existingQuickScan) {
                    enqueueCatalogScan('incremental', 'scheduled quick scan', {
                        scheduled: true, priority: 50
                    });
                } else if (!fullScanAlreadyCoversQuickScan && existingQuickScan && existingQuickScan.status === 'queued' && existingQuickScan.priority < 50) {
                    existingQuickScan.priority = 50;
                    queuedWorkOrder.sort((leftId, rightId) => {
                        const left = queuedWorkTasks.get(leftId);
                        const right = queuedWorkTasks.get(rightId);
                        return (Number(right?.priority) || 0) - (Number(left?.priority) || 0)
                            || (Number(left?.createdAt) || 0) - (Number(right?.createdAt) || 0);
                    });
                    refreshQueuedWorkPositions();
                }
                return;
            }

            const queuedScanExists = [...queuedWorkTasks.values()].some(task => task.kind === 'scan' && isQueueTaskPending(task));
            const queuedSyncExists = [...queuedWorkTasks.values()].some(task => task.kind === 'sync' && isQueueTaskPending(task));
            if (scanActive || organizerActive || hasActiveSyncJobs() || queuedScanExists || queuedSyncExists) return;

            const lastSyncCompletedRow = db.prepare("SELECT value FROM scan_settings WHERE key = 'last_sync_job_completed'").get();
            const lastSyncCompleted = Number.parseFloat(lastSyncCompletedRow?.value || 0);

            if (lastSyncCompleted > 0 && now - lastSyncCompleted < GLOBAL_SYNC_COOLDOWN_SECONDS) return;

            const dueUsers = db.prepare('SELECT * FROM users WHERE auto_sync = 1 AND sync_interval > 0').all()
                .filter(user => {
                    const schedule = normalizeIntervalToSchedule(user.sync_interval, USER_SYNC_SCHEDULES);
                    if (!schedule) return false;
                    if ((now - (Number(user.last_sync) || 0)) < schedule * 60) return false;
                    const currentJob = activeJobs[user.id];
                    if (isSyncJobInProgress(currentJob) || (currentJob && currentJob.status === 'queued')) return false;
                    if ([...queuedWorkTasks.values()].some(task => task.kind === 'sync' && task.userId === Number(user.id) && isQueueTaskPending(task))) return false;
                    const hasProviderPlaylist = ['spotify', 'youtube', 'apple'].includes(user.sync_provider) && String(user.sync_url || '').trim();
                    const hasTextPlaylist = !!db.prepare('SELECT 1 FROM user_text_playlist WHERE user_id = ? LIMIT 1').get(user.id);
                    return !!(hasProviderPlaylist || hasTextPlaylist);
                })

                .sort((a, b) => (Number(a.last_sync) || 0) - (Number(b.last_sync) || 0) || a.id - b.id);

            if (!dueUsers.length) return;

            const user = dueUsers[0];
            const hasProviderPlaylist = ['spotify', 'youtube', 'apple'].includes(user.sync_provider) && String(user.sync_url || '').trim();
            const hasTextPlaylist = !!db.prepare('SELECT 1 FROM user_text_playlist WHERE user_id = ? LIMIT 1').get(user.id);
            const source = hasProviderPlaylist ? user.sync_provider : 'text_playlist';
            const input = hasProviderPlaylist ? user.sync_url : '';

            enqueueUserSync(user, source, input, {
                autoApply: true,
                includeTextPlaylist: !!hasProviderPlaylist
            }, {
                scheduled: true,
                dedupeKey: `scheduled-sync-user-${user.id}`,
                label: `Scheduled sync — ${user.username || user.id}`,
                adminLabel: true,
                priority: 0
            });
            console.log(`[Scheduler] Added scheduled sync for ${user.username || user.id} to the work queue.`);
        } catch (error) {
            console.error('[Scheduler] Scheduler error:', error);
        } finally {
            schedulerTickRunning = false;
        }
    }, 15000);
}

let serverInstance;

async function startServer() {
    try {
        const USE_SSL = process.env.USE_SSL === 'true';

        if (USE_SSL) {
            let sslOptions = null;
            const certDir = path.join(__dirname, 'ssl');
            const keyPath = normalizeFilesystemPath(String(process.env.SSL_KEY_PATH || path.join(certDir, 'milo.key')));
            const certPath = normalizeFilesystemPath(String(process.env.SSL_CERT_PATH || path.join(certDir, 'milo.crt')));

            if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
                sslOptions = {
                    key: fs.readFileSync(keyPath),
                    cert: fs.readFileSync(certPath)
                };
            } else {
                console.log('[SSL] Certificates not found. Attempting to auto-generate self-signed certs...');
                try {
                    fs.mkdirSync(certDir, { recursive: true });
                    let generated = false;

                    try {
                        const selfsigned = require('selfsigned');
                        const pems = selfsigned.generate([{ name: 'commonName', value: 'milo.local' }], { days: 3650 });
                        fs.writeFileSync(keyPath, pems.private);
                        fs.writeFileSync(certPath, pems.cert);
                        sslOptions = { key: pems.private, cert: pems.cert };
                        generated = true;
                        console.log('[SSL] Auto-generated certs using "selfsigned" package.');
                    } catch (e) {}

                    if (!generated) {
                        execSync(`openssl req -x509 -newkey rsa:2048 -nodes -sha256 -subj "/CN=milo.local" -days 3650 -keyout "${keyPath}" -out "${certPath}"`, { stdio: 'ignore' });
                        sslOptions = {
                            key: fs.readFileSync(keyPath),
                            cert: fs.readFileSync(certPath)
                        };
                        console.log('[SSL] Auto-generated certs using OpenSSL.');
                    }
                } catch (err) {
                    console.error('[SSL Error] Failed to generate certs. Ensure OpenSSL is installed or supply certs manually. Falling back to HTTP.', err.message);
                }
            }

            if (sslOptions) {
                serverInstance = https.createServer(sslOptions, app);
            } else {
                serverInstance = http.createServer(app);
            }
        } else {
            serverInstance = http.createServer(app);
        }

        serverInstance.listen(PORT, '0.0.0.0', () => {
            const activeProtocol = (serverInstance instanceof https.Server) ? 'https' : 'http';
            console.log(`${activeProtocol.toUpperCase()} server running on port ${PORT}`);
            if (process.send) {
                process.send('server-ready');
            }
            runBackgroundScheduler(activeProtocol);

            try {
                const service = bonjour.publish({
                    name: 'MILO Web Server',
                    type: activeProtocol,
                    port: PORT,
                    protocol: 'tcp',
                    host: 'milo.local'
                });

                service.on('up', () => {
                    console.log(`[mDNS] ${activeProtocol.toUpperCase()} service 'MILO Web Server' is up and discoverable at ${activeProtocol}://milo.local:${PORT}`);
                });

                service.on('error', (err) => {
                    console.error(`[mDNS Error] Failed to publish service: ${err.message}`);
                });
            } catch (e) {
                console.error(`[mDNS Error] Exception while trying to publish service: ${e.message}`);
            }
        });
    } catch (error) {
        console.error('Failed to start the server:', error);
        process.exit(1);
    }
}

startServer();

process.on('SIGTERM', () => {
    console.log('[Server Shutdown] Stopping mDNS service...');
    bonjour.unpublishAll();
    bonjour.destroy();
    if (serverInstance) {
        serverInstance.close(() => {
            console.log('Server closed.');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});

process.on('SIGINT', () => {
    console.log('[Server Shutdown] Stopping mDNS service...');
    bonjour.unpublishAll();
    bonjour.destroy();
    if (serverInstance) {
        serverInstance.close(() => {
            console.log('Server closed.');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});
