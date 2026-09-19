require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const fuzz = require('fuzzball');
const mm = require('music-metadata');
const SpotifyWebApi = require('spotify-web-api-node');
const { Innertube } = require('youtubei.js');
const axios = require('axios');

let puppeteer;
try { puppeteer = require('puppeteer'); } catch (e) {}

const app = express();

const SECRET_KEY = process.env.FLASK_SECRET_KEY || 'super-secret-production-key';
const DB_PATH = process.env.DB_PATH || 'sync_app.db';
const MASTER_POOL_DIR = process.env.MASTER_POOL_DIR || 'C:\\Media\\Music\\MasterPool';
const SPOTIPY_CLIENT_ID = process.env.SPOTIPY_CLIENT_ID || '';
const SPOTIPY_CLIENT_SECRET = process.env.SPOTIPY_CLIENT_SECRET || '';
const APPLE_DEVELOPER_TOKEN = process.env.APPLE_DEVELOPER_TOKEN || '';

const DRIVEPOOL_DRIVES = process.env.DRIVEPOOL_DRIVES
    ? process.env.DRIVEPOOL_DRIVES.split(',').map(d => d.trim()).filter(Boolean)
    : [];

app.set('view engine', 'ejs');
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

app.use(session({
    secret: SECRET_KEY,
    resave: false,
    saveUninitialized: false
}));

const db = new Database(DB_PATH, { timeout: 15000 });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const historyDb = new Database('sync_history.db', { timeout: 15000 });
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
            apple_dev_token TEXT
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

        CREATE TABLE IF NOT EXISTS system_settings (
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
    `);

    const columns = [
        { name: 'auto_sync', def: "INTEGER DEFAULT 0" },
        { name: 'one_for_one', def: "INTEGER DEFAULT 0" },
        { name: 'sync_interval', def: "INTEGER DEFAULT 0" },
        { name: 'last_sync', def: "REAL DEFAULT 0" },
        { name: 'spotify_client_id', def: "TEXT" },
        { name: 'spotify_client_secret', def: "TEXT" },
        { name: 'apple_dev_token', def: "TEXT" }
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
        const targetDir = process.env.ADMIN_LIBRARY_PATH || path.join(process.cwd(), "Admin_Library");
        const hash = bcrypt.hashSync("admin", 10);
        db.prepare(
            "INSERT INTO users (username, password_hash, role, library_path, index_mode) VALUES (?, ?, ?, ?, ?)"
        ).run("admin", hash, "admin", targetDir, "standard");
    }

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
    `);
}

initDb();

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

function resolveDrivePoolPath(filePath) {
    if (!DRIVEPOOL_DRIVES.length || !filePath) return null;
    const parsed = path.parse(filePath);
    const relativePath = filePath.substring(parsed.root.length);

    for (const rawDrive of DRIVEPOOL_DRIVES) {
        let driveRoot = rawDrive.endsWith('\\') ? rawDrive : (rawDrive.endsWith(':') ? `${rawDrive}\\` : `${rawDrive}:\\`);
        try {
            if (!fs.existsSync(driveRoot)) continue;
            const entries = fs.readdirSync(driveRoot);
            const poolPart = entries.find(e => e.startsWith('PoolPart.'));

            if (poolPart) {
                const poolPartDir = path.join(driveRoot, poolPart);
                const physicalPath = path.join(poolPartDir, relativePath);
                if (fs.existsSync(physicalPath)) return { physicalPath, poolPartDir, relativePath };
            }
        } catch (e) {}
    }
    return null;
}

function removeExistingFileOrLink(filePath) {
    try {
        const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
        if (fs.existsSync(filePath) || (stat && (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()))) {
            fs.rmSync(filePath, { recursive: true, force: true });
        }
    } catch (e) {}
}

function linkFile(sourcePath, targetPath, mode = 'standard') {
    if (mode === 'advanced') {
        let actualSource = sourcePath;
        let actualTarget = targetPath;
        let activeDrivePoolDrive = null;

        if (DRIVEPOOL_DRIVES.length > 0) {
            const drivePoolSource = resolveDrivePoolPath(sourcePath);
            if (drivePoolSource) {
                actualSource = drivePoolSource.physicalPath;
                actualTarget = path.join(drivePoolSource.poolPartDir, targetPath.substring(path.parse(targetPath).root.length));
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
                const physicalTarget = path.join(drivePoolSource.poolPartDir, targetRelative);
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
            if (fs.existsSync(track.file_path)) {
                let relPath = path.relative(MASTER_POOL_DIR, track.file_path);
                if (relPath.startsWith('..')) relPath = path.basename(track.file_path);
                let targetPath = path.join(user.library_path, relPath);
                if (!path.resolve(targetPath).startsWith(path.resolve(user.library_path))) {
                    targetPath = path.join(user.library_path, path.basename(track.file_path));
                }
                linkFile(track.file_path, targetPath, newMode);
                processedTracks.push({ source: track.file_path, target: targetPath });
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
        const metadata = await mm.parseFile(filepath);
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

function extractPlaylistId(url, provider) {
    if (!url) return "";
    let match;
    if (provider === 'spotify') {
        match = url.match(/playlist\/([a-zA-Z0-9]+)/);
        return match ? match[1] : url.split('?')[0].trim();
    } else if (provider === 'youtube') {
        match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
        return match ? match[1] : url.trim();
    } else if (provider === 'apple') {
        match = url.match(/(pl\.[a-zA-Z0-9-]+)/);
        return match ? match[1] : url.trim();
    }
    return url.trim();
}

async function walkDir(dir) {
    let results = [];
    const list = await fs.promises.readdir(dir, { withFileTypes: true });
    for (let i = 0; i < list.length; i++) {
        if (i % 20 === 0) await new Promise(r => setImmediate(r));
        const file = list[i];
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            results = results.concat(await walkDir(fullPath));
        } else if (/\.(mp3|flac|m4a|ogg|wav)$/i.test(file.name)) {
            results.push(fullPath);
        }
    }
    return results;
}

let activeScanJob = { status: 'idle', progress: 0, total: 0, message: '' };

app.post('/api/catalog/scan', requireLogin, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: "Unauthorized" });
    if (!fs.existsSync(MASTER_POOL_DIR)) return res.status(400).json({ success: false, message: "Master pool directory not found." });

    if (activeScanJob.status === 'running' || activeScanJob.status === 'fetching') {
        return res.status(400).json({ success: false, message: "Scan already running." });
    }

    activeScanJob = { status: 'fetching', progress: 0, total: 0, message: 'Scanning directory...' };
    res.json({ success: true, message: "Scan started" });

    try {
        const files = await walkDir(MASTER_POOL_DIR);
        activeScanJob.total = files.length;
        activeScanJob.status = 'running';
        let scanned = 0;

        const insertStmt = db.prepare(`
            INSERT INTO catalog (file_path, title, artist, album, search_str, added_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(file_path) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album, search_str=excluded.search_str, added_at=excluded.added_at
        `);

        const transaction = db.transaction((batch) => {
            for (const item of batch) insertStmt.run(item.full_path, item.title, item.artist, item.album, item.search_str, item.mtime);
        });

        let batch = [];
        for (let i = 0; i < files.length; i++) {
            if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
            const fullPath = files[i];
            const { title, artist, album, cleanSearch } = await extractTags(fullPath);
            let mtime = 0;
            try { mtime = fs.statSync(fullPath).mtimeMs / 1000; } catch (e) {}

            batch.push({ full_path: fullPath, title, artist, album, search_str: cleanSearch, mtime });
            if (batch.length >= 100) {
                transaction(batch);
                scanned += batch.length;
                batch = [];
            }
            activeScanJob.progress = i + 1;
        }

        if (batch.length > 0) {
            transaction(batch);
            scanned += batch.length;
        }
        activeScanJob = { status: 'completed', message: `Indexed ${scanned} tracks.`, progress: scanned, total: scanned };
    } catch (e) {
        activeScanJob = { status: 'error', message: e.message };
    }
});

app.get('/api/catalog/scan-status', requireLogin, (req, res) => {
    res.json(activeScanJob);
});

app.post('/api/catalog/scan-dismiss', requireLogin, (req, res) => {
    if (activeScanJob.status !== 'running' && activeScanJob.status !== 'fetching') {
        activeScanJob = { status: 'idle', progress: 0, total: 0, message: '' };
    }
    res.json({success: true});
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

        if (!library_path) return res.status(400).json({ success: false, message: "Library path is required." });

        const normalizedPath = path.resolve(library_path);
        const existingUsers = db.prepare(`SELECT id, library_path FROM users`).all();
        if (existingUsers.some(u => path.resolve(u.library_path) === normalizedPath)) {
            return res.status(400).json({ success: false, message: "Library path is already in use by another user." });
        }

        try { fs.mkdirSync(library_path, { recursive: true }); } catch (e) { return res.status(400).json({ success: false, message: `Path error: ${e.message}` }); }
        try {
            const hash = bcrypt.hashSync(password, 10);
            db.prepare(`INSERT INTO users (username, password_hash, role, library_path, index_mode) VALUES (?, ?, ?, ?, ?)`)
              .run(username, hash, 'user', library_path, selectedMode);
            res.json({ success: true, message: "User created." });
        } catch (e) {
            if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ success: false, message: "Username exists" });
            res.status(500).json({ success: false, message: "Database error" });
        }
    });

app.put('/api/admin/users/:user_id', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: "Unauthorized" });
    const targetId = parseInt(req.params.user_id);
    const { username, password, library_path, index_mode } = req.body;
    const selectedMode = index_mode === 'advanced' ? 'advanced' : 'standard';

    if (!library_path) return res.status(400).json({ success: false, message: "Library path is required." });

    const normalizedPath = path.resolve(library_path);
    const existingUsers = db.prepare(`SELECT id, library_path FROM users`).all();
    if (existingUsers.some(u => u.id !== targetId && path.resolve(u.library_path) === normalizedPath)) {
        return res.status(400).json({ success: false, message: "Library path is already in use by another user." });
    }

    try { fs.mkdirSync(library_path, { recursive: true }); } catch (e) { return res.status(400).json({ success: false, message: `Path error: ${e.message}` }); }

    try {
        if (password && password.trim() !== "") {
            const hash = bcrypt.hashSync(password, 10);
            db.prepare(`UPDATE users SET username = ?, password_hash = ?, library_path = ?, index_mode = ? WHERE id = ?`)
              .run(username, hash, library_path, selectedMode, targetId);
        } else {
            db.prepare(`UPDATE users SET username = ?, library_path = ?, index_mode = ? WHERE id = ?`)
              .run(username, library_path, selectedMode, targetId);
        }
        res.json({ success: true, message: "User updated." });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ success: false, message: "Username exists" });
        res.status(500).json({ success: false, message: "Database error" });
    }
});

app.delete('/api/admin/users/:user_id', requireLogin, (req, res) => {
    const targetId = parseInt(req.params.user_id);
    if (req.user.role !== 'admin' || req.user.id === targetId) return res.status(403).json({ success: false, message: "Unauthorized or invalid target" });
    db.transaction(() => {
        db.prepare("DELETE FROM user_tracks WHERE user_id = ?").run(targetId);
        db.prepare("DELETE FROM missing_track_logs WHERE user_id = ?").run(targetId);
        db.prepare("DELETE FROM users WHERE id = ?").run(targetId);
    })();
    res.json({ success: true });
});

app.get('/api/admin/system-settings', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const rows = db.prepare("SELECT * FROM system_settings").all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json(settings);
});

app.post('/api/admin/system-settings', requireLogin, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({});
    const { master_scan_interval } = req.body;
    db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('master_scan_interval', ?)").run(master_scan_interval || '0');
    res.json({ success: true, message: "System settings saved." });
});

app.route('/api/admin/dead-files')
    .get(requireLogin, (req, res) => {
        if (req.user.role !== 'admin') return res.status(403).json({ success: false });
        const rows = db.prepare(`SELECT id, file_path, title, artist FROM catalog`).all();
        const dead = rows.filter(r => !fs.existsSync(r.file_path)).map(r => ({ id: r.id, title: r.title, artist: r.artist, path: r.file_path }));
        res.json(dead);
    })
    .delete(requireLogin, (req, res) => {
        if (req.user.role !== 'admin') return res.status(403).json({ success: false });
        if (!fs.existsSync(MASTER_POOL_DIR)) return res.status(400).json({ success: false, message: "Master pool directory missing. Aborting purge." });
        const rows = db.prepare(`SELECT id, file_path FROM catalog`).all();
        const deadIds = rows.filter(r => !fs.existsSync(r.file_path)).map(r => r.id);
        if (deadIds.length > 0) {
            db.transaction(() => {
                for (let i = 0; i < deadIds.length; i += 900) {
                    const batch = deadIds.slice(i, i + 900);
                    db.prepare(`DELETE FROM catalog WHERE id IN (${batch.map(() => '?').join(',')})`).run(...batch);
                }
            })();
        }
        res.json({ success: true, purged: deadIds.length });
    });

app.post('/api/user/sync-settings', requireLogin, (req, res) => {
    const { provider, url, auto_sync, one_for_one, sync_interval, spotify_client_id, spotify_client_secret, apple_dev_token } = req.body;
    db.prepare(`
        UPDATE users SET 
        sync_provider = ?, sync_url = ?, auto_sync = ?, one_for_one = ?, sync_interval = ?,
        spotify_client_id = ?, spotify_client_secret = ?, apple_dev_token = ?
        WHERE id = ?
    `).run(
        provider, url, auto_sync ? 1 : 0, one_for_one ? 1 : 0, parseInt(sync_interval) || 0,
        spotify_client_id || '', spotify_client_secret || '', apple_dev_token || '', req.user.id
    );
    res.json({ success: true, message: "Sync settings saved." });
});

app.get('/api/catalog', requireLogin, (req, res) => {
    const query = (req.query.q || '').trim().toLowerCase();
    const sortBy = req.query.sort || 'artist';
    const order = (req.query.order || 'asc').toUpperCase();
    const libraryFilter = req.query.library_filter || 'all';
    const pageParam = parseInt(req.query.page) || 1;
    const limitParam = req.query.limit === 'all' ? 'all' : (parseInt(req.query.limit) || 50);
    const validSorts = { title: 'title', artist: 'artist', album: 'album', added: 'added_at' };
    const sortCol = validSorts[sortBy] || 'artist';
    const orderDir = order === 'DESC' ? 'DESC' : 'ASC';

    const userTrackRows = db.prepare(`SELECT track_id FROM user_tracks WHERE user_id = ?`).all(req.user.id);
    const userTracks = new Set(userTrackRows.map(r => r.track_id));
    const totalCatalogCount = db.prepare("SELECT COUNT(*) AS total FROM catalog").get().total;

    if (libraryFilter === 'all' || libraryFilter === 'added') {
        const catalogRows = db.prepare(`SELECT id, file_path FROM catalog`).all();
        const catalogPaths = {};
        for (const row of catalogRows) catalogPaths[row.id] = row.file_path;
        for (const tid of userTracks) {
            const filePath = catalogPaths[tid];
            if (filePath && fs.existsSync(filePath)) {
                let relPath = path.relative(MASTER_POOL_DIR, filePath);
                if (relPath.startsWith('..')) relPath = path.basename(filePath);
                let targetLinkPath = path.join(req.user.library_path, relPath);
                if (!path.resolve(targetLinkPath).startsWith(path.resolve(req.user.library_path))) {
                    targetLinkPath = path.join(req.user.library_path, path.basename(filePath));
                }
                if (!fs.existsSync(targetLinkPath)) {
                    try { linkFile(filePath, targetLinkPath, req.user.index_mode || 'standard'); } catch (e) {}
                }
            }
        }
    }

    let conditions = [], params = [];
    if (query) {
        conditions.push("search_str LIKE ?");
        params.push(`%${query.replace(/[^\w\s]/g, ' ').trim()}%`);
    }

    const userTrackArray = Array.from(userTracks);
    if (libraryFilter === 'added' && userTrackArray.length > 0) {
        conditions.push(`id IN (${userTrackArray.map(() => '?').join(',')})`);
        params.push(...userTrackArray);
    } else if (libraryFilter === 'added' && userTrackArray.length === 0) {
        conditions.push("1 = 0");
    } else if (libraryFilter === 'unadded' && userTrackArray.length > 0) {
        conditions.push(`id NOT IN (${userTrackArray.map(() => '?').join(',')})`);
        params.push(...userTrackArray);
    }

    const whereClause = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
    const filteredCount = db.prepare(`SELECT COUNT(*) AS total FROM catalog${whereClause}`).get(...params).total;
    let baseQuery = `SELECT id, title, artist, album, added_at FROM catalog${whereClause} ORDER BY ${sortCol} ${orderDir}`;

    let pageNum = Math.max(1, pageParam);
    let limitNum = limitParam;
    let totalPages = 1;

    if (limitParam !== 'all') {
        limitNum = Math.max(1, limitParam);
        totalPages = Math.ceil(filteredCount / limitNum) || 1;
        if (pageNum > totalPages) pageNum = totalPages;
        const offset = (pageNum - 1) * limitNum;
        baseQuery += ` LIMIT ${limitNum} OFFSET ${offset}`;
    }

    const rows = db.prepare(baseQuery).all(...params);
    const results = rows.map(r => ({ id: r.id, title: r.title, artist: r.artist, album: r.album, in_library: userTracks.has(r.id) }));

    res.json({
        tracks: results,
        stats: { total: totalCatalogCount, library: userTracks.size, filtered: filteredCount, page: pageNum, limit: limitNum, totalPages: totalPages }
    });
});

app.post('/api/user/toggle-track', requireLogin, (req, res) => {
    const trackId = req.body.track_id;
    const track = db.prepare(`SELECT file_path FROM catalog WHERE id = ?`).get(trackId);
    if (!track) return res.status(404).json({ success: false });

    let relPath = path.relative(MASTER_POOL_DIR, track.file_path);
    if (relPath.startsWith('..')) relPath = path.basename(track.file_path);
    let linkPath = path.join(req.user.library_path, relPath);

    if (!path.resolve(linkPath).startsWith(path.resolve(req.user.library_path))) {
        linkPath = path.join(req.user.library_path, path.basename(track.file_path));
    }

    const existing = db.prepare(`SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?`).get(req.user.id, trackId);
    db.transaction(() => {
        if (existing) {
            db.prepare(`DELETE FROM user_tracks WHERE user_id = ? AND track_id = ?`).run(req.user.id, trackId);
            const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
            if (fs.existsSync(linkPath) || (stat && (stat.isSymbolicLink() || stat.isFile()))) {
                try { fs.rmSync(linkPath); } catch (e) {}
                let currDir = path.dirname(linkPath);
                while (currDir && path.resolve(currDir) !== path.resolve(req.user.library_path)) {
                    try { fs.rmdirSync(currDir); currDir = path.dirname(currDir); } catch (e) { break; }
                }
            }
        } else {
            db.prepare(`INSERT INTO user_tracks (user_id, track_id) VALUES (?, ?)`).run(req.user.id, trackId);
            try { linkFile(track.file_path, linkPath, req.user.index_mode || 'standard'); } catch (e) {}
            db.prepare(`DELETE FROM removed_history WHERE user_id = ? AND track_id = ?`).run(req.user.id, trackId);
        }
    })();
    res.json({ success: true });
});

const activeJobs = {};

app.post('/api/import/start-job', requireLogin, async (req, res) => {
    if (activeJobs[req.user.id] && activeJobs[req.user.id].status !== 'error') {
        return res.status(400).json({ success: false, message: "A sync job is already running." });
    }
    let { source_type, input_data } = req.body;
    input_data = input_data || '';

    if (!input_data && source_type === 'auto') {
        source_type = req.user.sync_provider;
        input_data = req.user.sync_url;
        if (!input_data) return res.status(400).json({ success: false, message: "No sync URL configured in settings." });
    }

    if (source_type === 'text' && typeof input_data !== 'string') {
        return res.status(400).json({ success: false, message: "Manual import data must be plain text." });
    }

    activeJobs[req.user.id] = { status: 'fetching', progress: 0, total: 0, result: null, error: null };
    res.json({ success: true, message: "Job started" });

    processSyncJob(req.user, source_type, input_data).catch(err => {
        console.error("Job failed:", err);
        if (activeJobs[req.user.id]) {
            activeJobs[req.user.id].status = 'error';
            activeJobs[req.user.id].error = err.message;
        }
    });
});

async function processSyncJob(user, source_type, input_data) {
    const job = activeJobs[user.id];
    if (source_type !== 'text' && source_type !== 'spotify' && source_type !== 'youtube' && source_type !== 'apple') {
        throw new Error(`Unsupported import source: ${source_type}`);
    }

    if (source_type !== 'text') input_data = extractPlaylistId(input_data, source_type);
    let raw_queries = [];
    const defaultUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    const sClientId = user.spotify_client_id || SPOTIPY_CLIENT_ID;
    const sClientSecret = user.spotify_client_secret || SPOTIPY_CLIENT_SECRET;
    const aDevToken = user.apple_dev_token || APPLE_DEVELOPER_TOKEN;

    if (source_type === 'text') {
        raw_queries = input_data.split(/\r?\n/).map(line => line.trim()).filter(line => line);
    } else if (source_type === 'spotify') {
        let gotAllTracks = false;

        if (!sClientId || !sClientSecret) {
            let scrapedSuccess = false;

            try {
                const tokenRes = await axios.get(`https://open.spotify.com/get_access_token?reason=transport&productType=web_player`, { headers: { 'User-Agent': defaultUA }, timeout: 10000 });
                let token = tokenRes.data?.accessToken;

                if (!token) {
                    const pageRes = await axios.get(`https://open.spotify.com/playlist/${input_data}`, { headers: { 'User-Agent': defaultUA }, timeout: 10000 });
                    const sessionMatch = pageRes.data.match(/"accessToken"\s*:\s*"([^"]+)"/);
                    if (sessionMatch) token = sessionMatch[1];
                }

                if (token) {
                    let offset = 0;
                    let hasMore = true;
                    const visitedOffsets = new Set();

                    while (hasMore) {
                        if (visitedOffsets.has(offset)) break;
                        visitedOffsets.add(offset);

                        try {
                            const nextUrl = `https://api.spotify.com/v1/playlists/${input_data}/tracks?limit=100&offset=${offset}`;
                            const tracksRes = await axios.get(nextUrl, { 
                                headers: { 
                                    'Authorization': `Bearer ${token}`,
                                    'User-Agent': defaultUA,
                                    'Origin': 'https://open.spotify.com',
                                    'Referer': 'https://open.spotify.com/'
                                }, 
                                timeout: 10000 
                            });

                            if (tracksRes.data && Array.isArray(tracksRes.data.items) && tracksRes.data.items.length > 0) {
                                for (const item of tracksRes.data.items) {
                                    if (item.track && item.track.name) {
                                        const artistName = item.track.artists?.[0]?.name || '';
                                        raw_queries.push(`${artistName} ${item.track.name}`.trim());
                                    }
                                }
                                const total = tracksRes.data.total || 0;
                                if (tracksRes.data.next && tracksRes.data.items.length > 0 && (total === 0 || raw_queries.length < total)) {
                                    offset += tracksRes.data.items.length;
                                } else {
                                    hasMore = false;
                                    gotAllTracks = true;
                                }
                            } else {
                                hasMore = false;
                            }
                        } catch (err) {
                            hasMore = false;
                        }
                    }
                }
                if (raw_queries.length > 0) scrapedSuccess = true;
            } catch (e) {}

            if (!gotAllTracks) {
                try {
                    const embedRes = await axios.get(`https://open.spotify.com/embed/playlist/${input_data}`, { headers: { 'User-Agent': defaultUA }, timeout: 10000 });
                    const nextDataMatch = embedRes.data.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
                    const embedQueries = [];
                    if (nextDataMatch) {
                        try {
                            const json = JSON.parse(nextDataMatch[1]);
                            const trackList = json?.props?.pageProps?.state?.data?.entity?.trackList || json?.props?.pageProps?.trackList || [];
                            for (const t of trackList) {
                                const title = t.title || t.name || '';
                                const artist = t.subtitle || t.artists?.[0]?.name || t.artist || '';
                                if (title) embedQueries.push(`${artist} ${title}`.trim());
                            }
                        } catch (e) {}
                    }
                    if (embedQueries.length === 0) {
                        const genericMatches = [...embedRes.data.matchAll(/class=["'][^"']*TrackListRow__title[^"']*["']>([^<]+)<\/div>.*?class=["'][^"']*TrackListRow__artists[^"']*["'][^>]*>([^<]+)/gsi)];
                        for (const m of genericMatches) {
                             const title = m[1].trim();
                             const artist = m[2].replace(/<[^>]+>/g, '').trim(); 
                             if (title) embedQueries.push(`${artist} ${title}`);
                        }
                    }
                    if (embedQueries.length > raw_queries.length) {
                        raw_queries = embedQueries;
                        scrapedSuccess = true;
                    }
                } catch (e) {}
            }

            if (!gotAllTracks) {
                try {
                    const fetchFn = typeof fetch !== 'undefined' ? fetch : require('axios');
                    const suInfo = require('spotify-url-info')(typeof fetch !== 'undefined' ? fetch : require('node-fetch'));
                    const tracks = await suInfo.getTracks(`https://open.spotify.com/playlist/${input_data}`);
                    if (tracks && tracks.length > raw_queries.length) {
                        const newQueries = [];
                        tracks.forEach(t => {
                            const artist = t.artists && t.artists[0] ? t.artists[0].name : '';
                            if (t.name) newQueries.push(`${artist} ${t.name}`.trim());
                        });
                        if (newQueries.length > raw_queries.length) {
                            raw_queries = newQueries;
                            scrapedSuccess = true;
                        }
                    }
                } catch (e) {}
            }

            if (!gotAllTracks && puppeteer) {
                try {
                    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
                    try {
                        const page = await browser.newPage();
                        await page.setViewport({ width: 1280, height: 920 });
                        const capturedTracks = new Set(raw_queries);

                        page.on('response', async (response) => {
                            try {
                                const url = response.url();
                                if (url.includes('spotify.com') && response.status() === 200) {
                                    const ct = response.headers()['content-type'] || '';
                                    if (ct.includes('application/json')) {
                                        const json = await response.json();
                                        const items = json?.items || json?.data?.playlistV2?.content?.items || [];
                                        if (Array.isArray(items)) {
                                            items.forEach(it => {
                                                const trk = it.track || it.itemV2?.data;
                                                if (trk) {
                                                    const name = trk.name || trk.title || '';
                                                    const artist = trk.artists?.items?.[0]?.profile?.name || trk.artists?.[0]?.name || '';
                                                    if (name) capturedTracks.add(`${artist} ${name}`.trim());
                                                }
                                            });
                                        }
                                    }
                                }
                            } catch(e) {}
                        });

                        await page.goto(`https://open.spotify.com/playlist/${input_data}`, { waitUntil: 'networkidle2' });
                        try { await page.evaluate(() => { const btn = document.querySelector('#onetrust-accept-btn-handler'); if (btn) btn.click(); }); } catch(e){}

                        let scrollAttempts = 0;
                        let lastSize = capturedTracks.size;
                        let noNewCount = 0;

                        while (scrollAttempts < 60 && noNewCount < 6) { 
                            const domTracks = await page.evaluate(() => {
                                const rows = document.querySelectorAll('[data-testid="tracklist-row"]');
                                const extracted = [];
                                rows.forEach(row => {
                                    const titleNode = row.querySelector('a[data-testid="internal-track-link"], div.Type__TypeElement-sc-goli3j-0[dir="auto"]');
                                    if (titleNode) {
                                        const title = titleNode.innerText.trim();
                                        const artistNodes = row.querySelectorAll('a[data-testid="creator-link"], span[data-testid="creator-link"]');
                                        let artist = artistNodes.length > 0 
                                            ? Array.from(artistNodes).map(n => n.innerText.trim()).join(' ') 
                                            : "";
                                        if (!artist) {
                                            const fallbackArtist = row.querySelector('.Type__TypeElement-sc-goli3j-0:not([data-testid="internal-track-link"])');
                                            if (fallbackArtist) artist = fallbackArtist.innerText.trim();
                                        }
                                        if (title) extracted.push(`${artist} ${title}`.trim());
                                    }
                                });
                                return extracted;
                            });

                            domTracks.forEach(t => capturedTracks.add(t));

                            if (capturedTracks.size === lastSize) {
                                noNewCount++;
                            } else {
                                noNewCount = 0;
                                lastSize = capturedTracks.size;
                            }

                            await page.evaluate(() => {
                                const main = document.querySelector('[role="main"]') || document.querySelector('.os-viewport') || document.querySelector('[data-testid="playlist-page"]')?.parentElement;
                                if (main) main.scrollTop += 1000;
                                else window.scrollBy(0, 1000);
                            });

                            await new Promise(resolve => setTimeout(resolve, 800));
                            scrollAttempts++;
                        }

                        if (capturedTracks.size > raw_queries.length) {
                            raw_queries = Array.from(capturedTracks);
                            scrapedSuccess = true;
                        }
                    } finally {
                        await browser.close();
                    }
                } catch (e) {
                    console.error("Puppeteer Spotify fallback error:", e);
                }
            }

            if (!scrapedSuccess && raw_queries.length === 0) throw new Error("Could not extract tracks from Spotify via scraping. Configure API credentials.");
        } else {
            const spotifyApi = new SpotifyWebApi({ clientId: sClientId, clientSecret: sClientSecret });
            const auth = await spotifyApi.clientCredentialsGrant();
            spotifyApi.setAccessToken(auth.body['access_token']);
            let offset = 0; let results;
            do {
                results = await spotifyApi.getPlaylistTracks(input_data, { offset, limit: 100 });
                for (const item of results.body.items) {
                    if (item.track && item.track.artists) raw_queries.push(`${item.track.artists[0].name} ${item.track.name}`);
                }
                offset += 100;
            } while (results.body.next);
        }
    } else if (source_type === 'youtube') {
        const yt = await Innertube.create();
        let pl = await yt.music.getPlaylist(input_data);
        const videos = [];
        if (pl.items) videos.push(...pl.items);
        while (pl.has_continuation) {
            pl = await pl.getContinuation();
            if (pl.items) videos.push(...pl.items);
        }
        for (const t of videos) {
            const artistName = t.authors?.[0]?.name || t.author?.[0]?.name || t.artists?.[0]?.name || '';
            const trackTitle = t.title || t.name || '';
            raw_queries.push(`${artistName} ${trackTitle}`);
        }
    } else if (source_type === 'apple') {
        let activeToken = aDevToken;

        if (!activeToken && puppeteer) {
            try {
                const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
                try {
                    const page = await browser.newPage();
                    await page.goto(`https://music.apple.com/us/playlist/${input_data}`, { waitUntil: 'domcontentloaded' });
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    const mkToken = await page.evaluate(() => {
                        try {
                            if (window.MusicKit && window.MusicKit.getInstance) {
                                const inst = window.MusicKit.getInstance();
                                if (inst && inst.developerToken) return inst.developerToken;
                            }
                        } catch(e) {}

                        try {
                            const meta = document.querySelector('meta[name="apple:client-data"]');
                            if (meta) {
                                const data = JSON.parse(meta.content);
                                if (data && data.mediaApiToken) return data.mediaApiToken;
                                if (data && data.token) return data.token;
                            }
                        } catch(e) {}

                        return null;
                    });

                    if (mkToken) activeToken = mkToken;
                } finally {
                    await browser.close();
                }
            } catch (e) {
                console.error("Puppeteer Apple token extraction error:", e);
            }
        }

        if (!activeToken) {
            try {
                const response = await axios.get(`https://music.apple.com/us/playlist/${input_data}`, { headers: { 'User-Agent': defaultUA }, timeout: 10000 });

                const webStateMatch = response.data.match(/<script[^>]+id="web-navigation-state"[^>]*>([\s\S]*?)<\/script>/i);
                if (webStateMatch) {
                    try {
                        const state = JSON.parse(webStateMatch[1]);
                        if (state?.storefronts?.token) activeToken = state.storefronts.token;
                    } catch(e) {}
                }

                if (!activeToken) {
                    const metaMatch = response.data.match(/<meta\s+name="[^"]*config\/environment"\s+content="([^"]+)"/i);
                    if (metaMatch) {
                        try {
                            const config = JSON.parse(decodeURIComponent(metaMatch[1]));
                            activeToken = config?.MEDIA_API?.token || config?.musicweb?.token || config?.token;
                        } catch (e) {}
                    }
                }

                if (!activeToken) {
                    const jwtMatches = response.data.match(/eyJhbGciOiJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g);
                    if (jwtMatches) {
                        const validMatch = jwtMatches.find(t => t.length > 150);
                        if (validMatch) activeToken = validMatch;
                    }
                }
            } catch (err) {}
        }

        let apiSuccess = false;
        if (activeToken) {
            let url = `https://api.music.apple.com/v1/catalog/us/playlists/${input_data}/tracks?limit=100`;
            const visitedUrls = new Set();
            let pageCount = 0;

            while (url && pageCount < 500) {
                if (visitedUrls.has(url)) break;
                visitedUrls.add(url);
                pageCount++;

                try {
                    const response = await axios.get(url, { 
                        headers: { 
                            'Authorization': `Bearer ${activeToken}`, 
                            'Origin': 'https://music.apple.com' 
                        }, 
                        timeout: 10000 
                    });

                    const items = response.data?.data || [];
                    if (!Array.isArray(items) || items.length === 0) break;

                    for (const item of items) {
                        if (item.attributes) {
                            const trackName = item.attributes.name || '';
                            const artistName = item.attributes.artistName || '';
                            if (trackName) raw_queries.push(`${artistName} ${trackName}`.trim());
                        }
                    }

                    let nextPath = response.data?.next;
                    if (nextPath) {
                        let nextUrl = nextPath.startsWith('http') ? nextPath : `https://api.music.apple.com${nextPath}`;
                        if (!nextUrl.includes('limit=')) {
                            nextUrl += (nextUrl.includes('?') ? '&' : '?') + 'limit=100';
                        }
                        url = (nextUrl !== url) ? nextUrl : null;
                    } else {
                        url = null;
                    }
                    apiSuccess = true;
                } catch (err) {
                    break;
                }
            }
        }

        if (!apiSuccess && raw_queries.length === 0) {
            let scrapedSuccess = false;
            const targetUrls = [`https://embed.music.apple.com/us/playlist/${input_data}`, `https://music.apple.com/us/playlist/${input_data}`];
            for (const targetUrl of targetUrls) {
                if (scrapedSuccess) break;
                try {
                    const response = await axios.get(targetUrl, { headers: { 'User-Agent': defaultUA }, timeout: 10000 });
                    const scrapedSet = new Set(raw_queries);

                    const ldMatches = [...response.data.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
                    for (const m of ldMatches) {
                        try {
                            const ld = JSON.parse(m[1]);
                            if (ld['@type'] === 'MusicPlaylist' || ld.track || ld.tracks) {
                                const tracks = ld.track || ld.tracks || [];
                                if (Array.isArray(tracks)) {
                                    tracks.forEach(item => {
                                        const trackName = item.name || '';
                                        const artistName = item.byArtist?.name || (Array.isArray(item.byArtist) ? item.byArtist[0]?.name : '') || '';
                                        if (trackName) scrapedSet.add(`${artistName} ${trackName}`.trim());
                                    });
                                }
                            }
                        } catch (e) {}
                    }

                    if (scrapedSet.size === 0) {
                        const fallbackMatches = [...response.data.matchAll(/<div[^>]*class=["'][^"']*songs-list-row__song-name["'][^>]*>([^<]+)<\/div>[\s\S]*?<a[^>]*class=["'][^"']*songs-list-row__link["'][^>]*>([^<]+)<\/a>/gi)];
                        for (const m of fallbackMatches) {
                            const trackName = m[1].trim();
                            const artistName = m[2].trim();
                            if (trackName) scrapedSet.add(`${artistName} ${trackName}`.trim());
                        }
                    }

                    if (scrapedSet.size > 0) {
                        raw_queries = Array.from(scrapedSet);
                        scrapedSuccess = true;
                    }
                } catch (err) {}
            }

            if ((!scrapedSuccess || raw_queries.length <= 100) && puppeteer) {
                try {
                    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
                    try {
                        const page = await browser.newPage();
                        await page.setViewport({ width: 1280, height: 920 });
                        await page.goto(`https://music.apple.com/us/playlist/${input_data}`, { waitUntil: 'networkidle2' });

                        let trackSet = new Set(raw_queries);
                        let scrollAttempts = 0;
                        let lastSize = trackSet.size;
                        let noNewCount = 0;

                        while (scrollAttempts < 60 && noNewCount < 5) {
                            const tracks = await page.evaluate(() => {
                                const rows = document.querySelectorAll('.songs-list-row');
                                const extracted = [];
                                rows.forEach(row => {
                                    const titleNode = row.querySelector('.songs-list-row__song-name');
                                    const artistNode = row.querySelector('.songs-list-row__by-line, .songs-list-row__link');
                                    if (titleNode) {
                                        const title = titleNode.innerText.trim();
                                        const artist = artistNode ? artistNode.innerText.trim() : '';
                                        if (title) extracted.push(`${artist} ${title}`.trim());
                                    }
                                });
                                return extracted;
                            });

                            tracks.forEach(t => trackSet.add(t));

                            if (trackSet.size === lastSize) {
                                noNewCount++;
                            } else {
                                noNewCount = 0;
                                lastSize = trackSet.size;
                            }

                            await page.evaluate(() => window.scrollBy(0, 1000));
                            await new Promise(resolve => setTimeout(resolve, 800));
                            scrollAttempts++;
                        }

                        if (trackSet.size > raw_queries.length) {
                            raw_queries = Array.from(trackSet);
                            scrapedSuccess = true;
                        }
                    } finally {
                        await browser.close();
                    }
                } catch (e) {
                    console.error("Puppeteer Apple fallback error:", e);
                }
            }

            if (!scrapedSuccess && raw_queries.length === 0) throw new Error("Could not extract tracks from Apple Music via scraping. Configure API Developer Token.");
        }
    }

    job.status = 'processing';
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
        db.prepare(`INSERT INTO missing_track_logs (user_id, query, source) VALUES (?, ?, ?)`).run(user.id, q, source_type);
    });

    const cacheInsert = historyDb.transaction((uid, src, rq, tid) => {
        historyDb.prepare(`INSERT OR REPLACE INTO playlist_cache (user_id, source_type, raw_query, track_id) VALUES (?, ?, ?, ?)`).run(uid, src, rq, tid);
    });

    for (let i = 0; i < raw_queries.length; i++) {
        job.progress = i + 1;
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
                if (userTracks.has(rec.id)) already_in_library.push(item);
                else matches_to_add.push(item);
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
            if (userTracks.has(rec.id)) already_in_library.push(item);
            else matches_to_add.push(item);

            memoryCache.set(clean_q, rec.id);
            cacheInsert(user.id, source_type, clean_q, rec.id);
        } else {
            missingSet.add(clean_q);
            missing.push({ query });
            logMissing(query);
        }
    }

    job.result = { matches: matches_to_add, exists: already_in_library, missing };

    if (user.auto_sync) {
        let syncedCount = 0;
        let removedCount = 0;

        if (matches_to_add.length > 0) {
            const tids = matches_to_add.map(m => m.track_id);
            syncedCount = applyTracksToLibrary(user, tids);
        }

        if (user.one_for_one) {
            const keepTids = new Set([...matches_to_add.map(m => m.track_id), ...already_in_library.map(m => m.track_id)]);
            removedCount = removeUnmatchedTracks(user, keepTids, userTracks);
        }

        job.status = 'auto_completed';
        job.result.added_count = syncedCount;
        job.result.removed_count = removedCount;
    } else {
        job.status = 'completed';
    }
}

function applyTracksToLibrary(user, trackIds) {
    let added = 0;
    db.transaction((tids) => {
        const checkExisting = db.prepare(`SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?`);
        const insertTrack = db.prepare(`INSERT INTO user_tracks (user_id, track_id) VALUES (?, ?)`);
        const getTrack = db.prepare(`SELECT file_path FROM catalog WHERE id = ?`);

        for (const tid of tids) {
            if (checkExisting.get(user.id, tid)) continue;
            insertTrack.run(user.id, tid);
            const track = getTrack.get(tid);
            if (track) {
                let relPath = path.relative(MASTER_POOL_DIR, track.file_path);
                if (relPath.startsWith('..')) relPath = path.basename(track.file_path);
                let targetLinkPath = path.join(user.library_path, relPath);
                if (!path.resolve(targetLinkPath).startsWith(path.resolve(user.library_path))) {
                    targetLinkPath = path.join(user.library_path, path.basename(track.file_path));
                }
                try {
                    linkFile(track.file_path, targetLinkPath, user.index_mode || 'standard');
                    added++;
                    historyDb.prepare(`DELETE FROM removed_history WHERE user_id = ? AND track_id = ?`).run(user.id, tid);
                } catch (e) {}
            }
        }
    })(trackIds);
    return added;
}

function removeUnmatchedTracks(user, keepTids, userTracksSet) {
    let removed = 0;
    const tracksToRemove = [];
    for (const tid of userTracksSet) {
        if (!keepTids.has(tid)) tracksToRemove.push(tid);
    }

    if (tracksToRemove.length === 0) return 0;

    const getTrack = db.prepare(`SELECT file_path FROM catalog WHERE id = ?`);
    db.transaction((tids) => {
        for (const tid of tids) {
            db.prepare(`DELETE FROM user_tracks WHERE user_id = ? AND track_id = ?`).run(user.id, tid);
            const track = getTrack.get(tid);
            if (track) {
                let relPath = path.relative(MASTER_POOL_DIR, track.file_path);
                if (relPath.startsWith('..')) relPath = path.basename(track.file_path);
                let linkPath = path.join(user.library_path, relPath);
                if (!path.resolve(linkPath).startsWith(path.resolve(user.library_path))) {
                    linkPath = path.join(user.library_path, path.basename(track.file_path));
                }
                const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
                if (fs.existsSync(linkPath) || (stat && (stat.isSymbolicLink() || stat.isFile()))) {
                    try { fs.rmSync(linkPath); } catch (e) {}
                }
            }
            historyDb.prepare(`INSERT INTO removed_history (user_id, track_id) VALUES (?, ?)`).run(user.id, tid);
            removed++;
        }
    })(tracksToRemove);
    return removed;
}

app.get('/api/import/status', requireLogin, (req, res) => {
    res.json(activeJobs[req.user.id] || { status: 'idle' });
});

app.post('/api/import/clear', requireLogin, (req, res) => {
    delete activeJobs[req.user.id];
    res.json({ success: true });
});

app.get('/api/user/missing-logs', requireLogin, (req, res) => {
    const logs = db.prepare(`SELECT id, query, source, timestamp FROM missing_track_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 100`).all(req.user.id);
    const catalogRows = db.prepare(`SELECT id, title, artist, search_str FROM catalog`).all();
    const catalogKeys = catalogRows.map(r => r.search_str);
    const catalogMap = {};
    for (const r of catalogRows) catalogMap[r.search_str] = r;

    const enrichedLogs = logs.map(log => {
        const clean_q = log.query.replace(/[^\w\s]/g, ' ').trim().toLowerCase();
        let suggestions = [];
        if (catalogKeys.length > 0 && clean_q) {
            const matches = fuzz.extract(clean_q, catalogKeys, { scorer: fuzz.token_set_ratio, limit: 3 });
            suggestions = matches.map(m => {
                const rec = catalogMap[m[0]];
                return { track_id: rec.id, display: `${rec.artist} - ${rec.title}`, confidence: m[1] };
            });
        }
        return { ...log, suggestions };
    });
    res.json(enrichedLogs);
});

app.delete('/api/user/missing-logs/all', requireLogin, (req, res) => {
    db.prepare(`DELETE FROM missing_track_logs WHERE user_id = ?`).run(req.user.id);
    res.json({ success: true });
});

app.delete('/api/user/missing-logs/:log_id', requireLogin, (req, res) => {
    db.prepare(`DELETE FROM missing_track_logs WHERE id = ? AND user_id = ?`).run(req.params.log_id, req.user.id);
    res.json({ success: true });
});

app.post('/api/user/missing-logs/resolve', requireLogin, (req, res) => {
    const { log_id, track_id } = req.body;
    db.transaction(() => {
        const existing = db.prepare(`SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?`).get(req.user.id, track_id);
        if (!existing) db.prepare(`INSERT INTO user_tracks (user_id, track_id) VALUES (?, ?)`).run(req.user.id, track_id);
        db.prepare(`DELETE FROM missing_track_logs WHERE id = ? AND user_id = ?`).run(log_id, req.user.id);
    })();

    const track = db.prepare(`SELECT file_path FROM catalog WHERE id = ?`).get(track_id);
    if (track) {
        let relPath = path.relative(MASTER_POOL_DIR, track.file_path);
        if (relPath.startsWith('..')) relPath = path.basename(track.file_path);
        let linkPath = path.join(req.user.library_path, relPath);
        if (!path.resolve(linkPath).startsWith(path.resolve(req.user.library_path))) {
            linkPath = path.join(req.user.library_path, path.basename(track.file_path));
        }
        try { linkFile(track.file_path, linkPath, req.user.index_mode || 'standard'); } catch (e) {}
    }
    historyDb.prepare(`DELETE FROM removed_history WHERE user_id = ? AND track_id = ?`).run(req.user.id, track_id);
    res.json({ success: true });
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
    const { track_ids } = req.body;
    let added = applyTracksToLibrary(req.user, track_ids);
    res.json({ success: true, message: `Restored ${added} tracks.` });
});

app.post('/api/import/confirm', requireLogin, (req, res) => {
    const trackIds = Array.isArray(req.body.track_ids) ? req.body.track_ids : [];
    const keepTids = new Set([...trackIds, ...(req.body.existing_ids || [])]);
    const added = applyTracksToLibrary(req.user, trackIds);

    if (req.user.one_for_one) {
        const userTrackRows = db.prepare(`SELECT track_id FROM user_tracks WHERE user_id = ?`).all(req.user.id);
        const userTracks = new Set(userTrackRows.map(r => r.track_id));
        removeUnmatchedTracks(req.user, keepTids, userTracks);
    }

    res.json({ success: true, message: `Synced tracks successfully.` });
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

function runBackgroundScheduler() {
    setInterval(async () => {
        const now = Date.now() / 1000;

        try {
            const masterIntervalRow = db.prepare("SELECT value FROM system_settings WHERE key = 'master_scan_interval'").get();
            const lastMasterScanRow = db.prepare("SELECT value FROM system_settings WHERE key = 'last_master_scan'").get();
            const masterInterval = parseInt(masterIntervalRow?.value || 0) * 60;
            const lastMasterScan = parseFloat(lastMasterScanRow?.value || 0);

            if (masterInterval > 0 && (now - lastMasterScan >= masterInterval)) {
                if (activeScanJob.status === 'idle' || activeScanJob.status === 'completed' || activeScanJob.status === 'error') {
                    db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('last_master_scan', ?)").run(now);
                    axios.post('http://localhost:8088/api/catalog/scan', {}, {
                        headers: { 'Cookie': `connect.sid=scheduler` } 
                    }).catch(()=>{}); 

                    if (fs.existsSync(MASTER_POOL_DIR) && (activeScanJob.status !== 'running' && activeScanJob.status !== 'fetching')) {
                        activeScanJob = { status: 'fetching', progress: 0, total: 0, message: 'Scheduled Master Scan...' };
                        walkDir(MASTER_POOL_DIR).then(async (files) => {
                            activeScanJob.total = files.length;
                            activeScanJob.status = 'running';
                            let scanned = 0;
                            const insertStmt = db.prepare(`
                                INSERT INTO catalog (file_path, title, artist, album, search_str, added_at)
                                VALUES (?, ?, ?, ?, ?, ?)
                                ON CONFLICT(file_path) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album, search_str=excluded.search_str, added_at=excluded.added_at
                            `);
                            const transaction = db.transaction((b) => { for (const it of b) insertStmt.run(it.full_path, it.title, it.artist, it.album, it.search_str, it.mtime); });
                            let batch = [];
                            for (let i = 0; i < files.length; i++) {
                                if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
                                const fullPath = files[i];
                                const { title, artist, album, cleanSearch } = await extractTags(fullPath);
                                let mtime = 0; try { mtime = fs.statSync(fullPath).mtimeMs / 1000; } catch (e) {}
                                batch.push({ full_path: fullPath, title, artist, album, search_str: cleanSearch, mtime });
                                if (batch.length >= 100) { transaction(batch); scanned += batch.length; batch = []; }
                                activeScanJob.progress = i + 1;
                            }
                            if (batch.length > 0) { transaction(batch); scanned += batch.length; }
                            activeScanJob = { status: 'completed', message: `Indexed ${scanned} tracks.`, progress: scanned, total: scanned };
                        }).catch(e => activeScanJob = { status: 'error', message: e.message });
                    }
                }
            }

            const users = db.prepare("SELECT * FROM users WHERE auto_sync = 1 AND sync_interval > 0 AND sync_url != ''").all();
            for (const u of users) {
                if (now - u.last_sync >= u.sync_interval * 60) {
                    if (!activeJobs[u.id]) {
                        activeJobs[u.id] = { status: 'fetching', progress: 0, total: 0, result: null, error: null };
                        processSyncJob(u, u.sync_provider, u.sync_url).catch(e => {
                            if(activeJobs[u.id]) { activeJobs[u.id].status = 'error'; activeJobs[u.id].error = e.message; }
                        });
                        db.prepare("UPDATE users SET last_sync = ? WHERE id = ?").run(now, u.id);
                    }
                }
            }
        } catch (e) {
            console.error("Scheduler Error:", e);
        }
    }, 60000);
}

app.listen(8088, '0.0.0.0', () => {
    console.log("Server running on http://0.0.0.0:8088");
    runBackgroundScheduler();
});
