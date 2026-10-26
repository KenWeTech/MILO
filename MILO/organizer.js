'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const mm = require('music-metadata');
const fuzz = require('fuzzball');

const AUDIO_EXTENSIONS = /\.(mp3|flac|m4a|ogg|wav|opus|aac|wma|aiff|aif)$/i;
const DEFAULT_NAMING_SCRIPT = [
    '$if2(%albumartist%,%artist%)/',
    '',
    '$if2(%album%,%title% \\(Single\\))$if($if2(%originaldate%,%date%), \\($left($if2(%originaldate%,%date%),4)\\),)/',
    '',
    '$if($gt(%totaldiscs%,1),%discnumber%-,)',
    '',
    '$if(%tracknumber%,$num(%tracknumber%,2) - ,)',
    '',
    '$if(%_multiartist%,%artist% - ,)',
    '',
    '%title%',
    '',
    '$if($eq(%_extension%,flac),$if($eq(%_bits_per_sample%,24), [FLAC 24bit], [FLAC]),$if($eq(%_codec%,ALAC), [ALAC],$if($eq(%_extension%,mp3), [MP3-%_bitrate%k],)))'
].join('\n');
const LEGACY_DEFAULT_NAMING_SCRIPT = '$if2(%albumartist%,%artist%) - \\($left(%date%,4)\\) %album%/$num(%tracknumber%,2) - %title%';
const PREVIOUS_FORMAT_SUFFIX_BRANCH = '$if($eq(%_extension%,flac), [FLAC],$if($eq(%_codec%,ALAC), [ALAC],$if($eq(%_extension%,mp3), [MP3-%_bitrate%k],)))';
const OLDER_FORMAT_SUFFIX_BRANCH = '$if($eq(%_extension%,flac), [FLAC],$if($eq(%_extension%,mp3), [MP3-%_bitrate%k],))';
const CURRENT_FORMAT_SUFFIX_BRANCH = '$if($eq(%_extension%,flac),$if($eq(%_bits_per_sample%,24), [FLAC 24bit], [FLAC]),$if($eq(%_codec%,ALAC), [ALAC],$if($eq(%_extension%,mp3), [MP3-%_bitrate%k],)))';
const LEGACY_FORMAT_SUFFIX_DEFAULT_SCRIPTS = [
    DEFAULT_NAMING_SCRIPT.replace(CURRENT_FORMAT_SUFFIX_BRANCH, PREVIOUS_FORMAT_SUFFIX_BRANCH),
    DEFAULT_NAMING_SCRIPT.replace(CURRENT_FORMAT_SUFFIX_BRANCH, OLDER_FORMAT_SUFFIX_BRANCH),
    DEFAULT_NAMING_SCRIPT.replace(CURRENT_FORMAT_SUFFIX_BRANCH, '$if($eq(%_extension%,flac), [FLAC], [MP3-%_bitrate%k])')
];

function normalizeNamingScriptForMigration(script) {
    return String(script || '').replace(/\r\n/g, '\n').replace(/[\t\r\n ]+/g, ' ').trim();
}

function isLegacyDefaultNamingScript(script) {
    const candidate = normalizeNamingScriptForMigration(script);
    return [LEGACY_DEFAULT_NAMING_SCRIPT, ...LEGACY_FORMAT_SUFFIX_DEFAULT_SCRIPTS]
        .some(legacy => normalizeNamingScriptForMigration(legacy) === candidate);
}

function normalized(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
}

function normalizeFilesystemPath(...values) {
    const parts = values.map(value => String(value == null ? '' : value).trim().replace(/\\/g, '/'));
    if (!parts.length || !parts[0]) return '';
    return path.resolve(...parts).replace(/\\/g, '/');
}

function pathIsInside(candidatePath, rootPath) {
    if (!candidatePath || !rootPath) return false;
    const candidate = normalizeFilesystemPath(candidatePath);
    const root = normalizeFilesystemPath(rootPath);
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function pathIsSameOrInside(candidatePath, rootPath) {
    return !!candidatePath && !!rootPath && (normalizeFilesystemPath(candidatePath) === normalizeFilesystemPath(rootPath) || pathIsInside(candidatePath, rootPath));
}

function splitScriptArguments(input) {
    const args = [];
    let start = 0;
    let depth = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (char === '\\' && i + 1 < input.length && (input[i + 1] === '(' || input[i + 1] === ')')) {
            i++;
            continue;
        }
        if (char === '$' && /[A-Za-z_]/.test(input[i + 1] || '')) {
            let j = i + 1;
            while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
            if (input[j] === '(') {
                depth++;
                i = j;
                continue;
            }
        }
        if (char === '(') depth++;
        else if (char === ')') depth = Math.max(0, depth - 1);
        else if (char === ',' && depth === 0) {
            args.push(input.slice(start, i));
            start = i + 1;
        }
    }
    args.push(input.slice(start));
    return args;
}

function findFunctionClose(input, openIndex) {
    let depth = 1;
    for (let i = openIndex + 1; i < input.length; i++) {
        const char = input[i];
        if (char === '\\' && i + 1 < input.length && (input[i + 1] === '(' || input[i + 1] === ')')) {
            i++;
            continue;
        }
        if (char === '(') depth++;
        if (char === ')' && --depth === 0) return i;
    }
    return -1;
}

function evaluatePicardScript(script, tags) {
    const values = Object.create(null);
    for (const [key, value] of Object.entries(tags || {})) {

        values[key.toLowerCase()] = value == null ? '' : String(value).replace(/[\\/]/g, '_');
    }
    values.albumartist = values.albumartist || values.album_artist || values.artist || '';
    values.tracknumber = values.tracknumber || values.track || '';
    values.discnumber = values.discnumber || values.disc || '';

    function evaluate(input, depth = 0) {
        if (depth > 30) throw new Error('Naming script contains too many nested functions.');
        let output = '';
        for (let i = 0; i < input.length; i++) {
            const char = input[i];
            if (char === '\\' && i + 1 < input.length && (input[i + 1] === '(' || input[i + 1] === ')')) {
                output += input[++i];
                continue;
            }
            if (char === '%') {
                const end = input.indexOf('%', i + 1);
                if (end !== -1) {
                    const field = input.slice(i + 1, end).trim().toLowerCase();
                    output += values[field] || '';
                    i = end;
                    continue;
                }
            }
            if (char === '$' && /[A-Za-z_]/.test(input[i + 1] || '')) {
                let nameEnd = i + 1;
                while (nameEnd < input.length && /[A-Za-z0-9_]/.test(input[nameEnd])) nameEnd++;
                const fnName = input.slice(i + 1, nameEnd).toLowerCase();
                if (input[nameEnd] === '(') {
                    const close = findFunctionClose(input, nameEnd);
                    if (close === -1) throw new Error(`Unclosed $${fnName}() in naming script.`);
                    const rawArgs = splitScriptArguments(input.slice(nameEnd + 1, close));
                    const args = rawArgs.map(arg => evaluate(arg, depth + 1));
                    const first = args[0] || '';
                    let result = '';
                    switch (fnName) {
                        case 'if2':
                            result = args.find(value => String(value).trim() !== '') || '';
                            break;
                        case 'if':
                            result = first.trim() !== '' ? (args[1] || '') : (args[2] || '');
                            break;
                        case 'ifnot':
                            result = first.trim() === '' ? (args[1] || '') : (args[2] || '');
                            break;
                        case 'ifempty':
                            result = first.trim() === '' ? (args[1] || '') : first;
                            break;
                        case 'left': {
                            const count = Math.max(0, parseInt(args[1], 10) || 0);
                            result = Array.from(first).slice(0, count).join('');
                            break;
                        }
                        case 'right': {
                            const count = Math.max(0, parseInt(args[1], 10) || 0);
                            result = count ? Array.from(first).slice(-count).join('') : '';
                            break;
                        }
                        case 'num': {
                            const numberText = first.split('/')[0].trim();
                            const number = parseInt(numberText, 10);
                            const width = Math.max(0, Math.min(20, parseInt(args[1], 10) || 0));
                            result = Number.isFinite(number) ? String(number).padStart(width, '0') : first;
                            break;
                        }
                        case 'eq':
                            result = String(args[0] || '').trim().toLowerCase() === String(args[1] || '').trim().toLowerCase() ? '1' : '';
                            break;
                        case 'gt': {
                            const left = Number.parseFloat(args[0]);
                            const right = Number.parseFloat(args[1]);
                            result = Number.isFinite(left) && Number.isFinite(right) && left > right ? '1' : '';
                            break;
                        }
                        case 'upper': result = first.toLocaleUpperCase(); break;
                        case 'lower': result = first.toLocaleLowerCase(); break;
                        case 'trim': result = first.trim(); break;
                        case 'replace': {
                            const search = args[1] || '';
                            const replacement = args[2] || '';
                            result = search ? first.split(search).join(replacement) : first;
                            break;
                        }
                        case 'rreplace': {
                            try { result = first.replace(new RegExp(args[1] || '', 'g'), args[2] || ''); }
                            catch (_) { result = first; }
                            break;
                        }
                        case 'noop': result = ''; break;
                        default:
                            throw new Error(`Unsupported naming-script function: $${fnName}().`);
                    }
                    output += result;
                    i = close;
                    continue;
                }
            }
            output += char;
        }
        return output;
    }

    return evaluate(String(script || '')).replace(/\r?\n/g, '').trim();
}

function safeSegment(segment) {
    let cleaned = String(segment || '').replace(/[<>:"|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').trim();
    if (!cleaned || cleaned === '.' || cleaned === '..') return '';

    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(cleaned)) cleaned = `_${cleaned}`;
    return cleaned.slice(0, 180);
}

function cleanFilenameTitle(filename) {
    let title = path.parse(filename).name;
    title = title.replace(/^\s*\d{1,3}(?:\s*[._-]\s*|\s+)/, '').trim();
    const separator = title.indexOf(' - ');
    if (separator >= 0 && separator < 12) title = title.slice(separator + 3).trim();
    return title;
}

function pathSuggestedTags(filePath, dumpRoot) {
    const relative = path.relative(dumpRoot, filePath);
    const pieces = relative.split(path.sep).filter(Boolean);
    const filename = pieces.pop() || path.basename(filePath);
    const title = cleanFilenameTitle(filename);
    let artist = '';
    let album = '';
    if (pieces.length >= 2) {
        artist = pieces[pieces.length - 2];
        album = pieces[pieces.length - 1];
    } else if (pieces.length === 1) {
        album = pieces[0];
    }
    return { title, artist, album, albumartist: artist, source_path_title: title, source_path_artist: artist, source_path_album: album };
}

class Organizer {
    constructor(options) {
        this.dbPath = normalizeFilesystemPath(options.dbPath);
        this.poolDir = normalizeFilesystemPath(options.poolDir);
        this.getScanSettings = options.getScanSettings;
        this.onCatalogPathChanged = options.onCatalogPathChanged || (() => {});
        this.onPoolFileAdded = options.onPoolFileAdded || (() => {});
        this.db = new Database(path.join(path.dirname(this.dbPath), 'organizer_history.db'), { timeout: 15000 });
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS file_records (
                file_path TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL,
                size INTEGER NOT NULL DEFAULT 0,
                mtime_ms REAL NOT NULL DEFAULT 0,
                source_type TEXT NOT NULL DEFAULT 'pool',
                metadata_json TEXT,
                last_seen REAL NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_organizer_hash ON file_records(sha256, source_type);
            CREATE INDEX IF NOT EXISTS idx_organizer_source ON file_records(source_type);

            CREATE TABLE IF NOT EXISTS review_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_path TEXT NOT NULL,
                candidate_path TEXT NOT NULL,
                matched_path TEXT,
                planned_path TEXT,
                kind TEXT NOT NULL,
                confidence REAL DEFAULT 0,
                reason TEXT NOT NULL,
                metadata_json TEXT,
                tags_json TEXT,
                sha256 TEXT,
                file_size INTEGER DEFAULT 0,
                file_mtime_ms REAL DEFAULT 0,
                assigned_user_id INTEGER,
                status TEXT NOT NULL DEFAULT 'pending',
                action TEXT,
                created_at REAL NOT NULL,
                resolved_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_organizer_reviews_pending ON review_queue(status, created_at);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS ignored_paths (
                path TEXT PRIMARY KEY,
                size INTEGER NOT NULL,
                mtime_ms REAL NOT NULL,
                reason TEXT,
                added_at REAL NOT NULL
            );
        `);

        const reviewColumns = this.db.pragma('table_info(review_queue)');
        if (!reviewColumns.some(column => column.name === 'assigned_user_id')) {
            this.db.exec('ALTER TABLE review_queue ADD COLUMN assigned_user_id INTEGER');
        }
        this.normalizeStoredFilesystemPaths();
        const savedNamingScript = this.db.prepare("SELECT value FROM settings WHERE key = 'naming_script'").get();

        if (savedNamingScript && isLegacyDefaultNamingScript(savedNamingScript.value)) {
            this.db.prepare("UPDATE settings SET value = ? WHERE key = 'naming_script'").run(DEFAULT_NAMING_SCRIPT);
        }
        this.running = false;
        this.poolTitleIndex = null;
    }

    normalizeStoredFilesystemPaths() {
        const normalizeValue = value => value == null || value === '' ? value : normalizeFilesystemPath(value);
        const records = this.db.prepare('SELECT file_path, sha256, size, mtime_ms, source_type, metadata_json, last_seen FROM file_records').all();
        const updateRecord = this.db.prepare('UPDATE file_records SET file_path = ? WHERE file_path = ?');
        const deleteRecord = this.db.prepare('DELETE FROM file_records WHERE file_path = ?');
        for (const row of records) {
            const canonical = normalizeValue(row.file_path);
            if (!canonical || canonical === row.file_path) continue;
            const existing = this.db.prepare('SELECT file_path FROM file_records WHERE file_path = ?').get(canonical);
            if (existing && existing.file_path !== row.file_path) deleteRecord.run(row.file_path);
            else {
                try { updateRecord.run(canonical, row.file_path); }
                catch (_) { deleteRecord.run(row.file_path); }
            }
        }

        const reviews = this.db.prepare('SELECT id, source_path, candidate_path, matched_path, planned_path FROM review_queue').all();
        const updateReview = this.db.prepare('UPDATE review_queue SET source_path = ?, candidate_path = ?, matched_path = ?, planned_path = ? WHERE id = ?');
        for (const row of reviews) {
            const next = [row.source_path, row.candidate_path, row.matched_path, row.planned_path].map(normalizeValue);
            if (next.some((value, i) => value !== [row.source_path, row.candidate_path, row.matched_path, row.planned_path][i])) {
                updateReview.run(next[0], next[1], next[2], next[3], row.id);
            }
        }

        const ignored = this.db.prepare('SELECT path FROM ignored_paths').all();
        const updateIgnored = this.db.prepare('UPDATE ignored_paths SET path = ? WHERE path = ?');
        const deleteIgnored = this.db.prepare('DELETE FROM ignored_paths WHERE path = ?');
        for (const row of ignored) {
            const canonical = normalizeFilesystemPath(row.path);
            if (!canonical || canonical === row.path) continue;
            const existing = this.db.prepare('SELECT path FROM ignored_paths WHERE path = ?').get(canonical);
            if (existing && existing.path !== row.path) deleteIgnored.run(row.path);
            else {
                try { updateIgnored.run(canonical, row.path); }
                catch (_) { deleteIgnored.run(row.path); }
            }
        }
    }

    getSettings() {
        const rows = this.db.prepare('SELECT key, value FROM settings').all();
        const settings = {};
        for (const row of rows) settings[row.key] = row.value;
        return {
            naming_script: settings.naming_script || DEFAULT_NAMING_SCRIPT,
            rename_files: settings.rename_files === undefined ? '0' : settings.rename_files
        };
    }

    saveSettings(input = {}) {
        const script = String(input.naming_script === undefined ? DEFAULT_NAMING_SCRIPT : input.naming_script).trim();
        if (!script) throw new Error('Naming script cannot be empty.');
        if (script.length > 5000) throw new Error('Naming script is too long (maximum 5,000 characters).');
        this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('naming_script', script);
        this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('rename_files', input.rename_files ? '1' : '0');
        return this.getSettings();
    }

    getScanConfig() {
        const settings = this.getScanSettings ? (this.getScanSettings() || {}) : {};
        const dumps = Array.isArray(settings.dump_folders) ? settings.dump_folders : [];
        const dumpFolderEntries = dumps.map(item => {
            const configuredPath = typeof item === 'string' ? item : item && item.path;
            if (!configuredPath) return null;
            const rawUserId = item && typeof item === 'object' ? Number.parseInt(item.user_id, 10) : 0;
            return {
                path: this.resolveConfiguredPath(configuredPath),
                user_id: Number.isSafeInteger(rawUserId) && rawUserId > 0 ? rawUserId : null
            };
        }).filter(Boolean);
        const dumpFolders = dumpFolderEntries.map(item => item.path);
        const exemptFolders = (Array.isArray(settings.exempt_folders) ? settings.exempt_folders : [])
            .filter(Boolean).map(item => this.resolveConfiguredPath(item));
        const trashFolder = settings.trash_folder ? this.resolveConfiguredPath(settings.trash_folder) : '';
        return { dumpFolders, dumpFolderEntries, exemptFolders, trashFolder };
    }

    resolveConfiguredPath(input) {
        const raw = String(input == null ? '' : input).trim().replace(/\\/g, '/');
        return normalizeFilesystemPath(path.isAbsolute(raw) ? raw : path.join(this.poolDir, raw));
    }

    async hashFile(filePath) {
        filePath = normalizeFilesystemPath(filePath);
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('error', reject);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
        });
    }

    async readTags(filePath) {
        filePath = normalizeFilesystemPath(filePath);
        const extension = path.extname(filePath).slice(1).toLowerCase();
        const tags = {
            title: '', artist: '', albumartist: '', album: '', date: '', originaldate: '',
            tracknumber: '', discnumber: '', totaldiscs: '', genre: '', duration: '',
            _extension: extension, _bitrate: '', _codec: '', _lossless: false, _bits_per_sample: '', _bit_depth: '', _multiartist: '', _organizer_metadata_version: 7
        };
        try {
            const parsed = await mm.parseFile(filePath, {
                skipCovers: true,

                ...(['opus', 'ogg'].includes(extension) ? { duration: true } : {})
            });
            const common = parsed.common || {};
            tags.title = String(common.title || '').trim();
            tags.artist = String(common.artist || '').trim();
            tags.albumartist = String(common.albumartist || common.albumArtist || '').trim();
            tags.album = String(common.album || '').trim();
            tags.date = String(common.date || common.year || '').trim();
            tags.originaldate = String(common.originaldate || common.originalDate || '').trim();
            tags.tracknumber = common.track && common.track.no != null ? String(common.track.no) : '';
            tags.discnumber = common.disk && common.disk.no != null ? String(common.disk.no) : '';
            tags.totaldiscs = common.disk && common.disk.of != null ? String(common.disk.of) : '';
            tags.genre = Array.isArray(common.genre) ? String(common.genre[0] || '') : String(common.genre || '');
            tags.duration = parsed.format && Number.isFinite(parsed.format.duration) ? Number(parsed.format.duration) : '';
            let bitrate = Number(parsed.format && parsed.format.bitrate) || 0;
            if (!bitrate && Number(tags.duration) > 0) {
                try { bitrate = (fs.statSync(filePath).size * 8) / Number(tags.duration); } catch (_) {}
            }
            if (bitrate > 0 && Number.isFinite(bitrate)) tags._bitrate = String(Math.round(bitrate / 1000));
            tags._codec = String(parsed.format && parsed.format.codec || '').trim();
            if (/\balac\b|apple\s+lossless/i.test(tags._codec)) tags._codec = 'ALAC';
            const bitsPerSample = Number(parsed.format && parsed.format.bitsPerSample) || 0;
            tags._bits_per_sample = bitsPerSample > 0 ? String(bitsPerSample) : '';
            tags._bit_depth = tags._bits_per_sample;
            const sampleRate = Number(parsed.format && parsed.format.sampleRate) || 0;
            tags._sample_rate = sampleRate > 0 ? String(sampleRate) : '';
            tags._lossless = !!(parsed.format && parsed.format.lossless);
            const artists = Array.isArray(common.artists) ? common.artists.map(value => String(value || '').trim()).filter(Boolean) : [];
            tags._multiartist = artists.length > 1 ? '1' : '';
        } catch (_) {}

        tags._organizer_metadata_version = 7;
        return tags;
    }

    async statAndHash(filePath, knownHash = '', forceHash = false) {
        filePath = normalizeFilesystemPath(filePath);
        const stat = await fs.promises.stat(filePath);
        const resolved = filePath;
        let previous = this.db.prepare('SELECT file_path, sha256, size, mtime_ms FROM file_records WHERE file_path = ?').get(resolved);
        if (!previous) {
            previous = this.db.prepare("SELECT file_path, sha256, size, mtime_ms FROM file_records WHERE source_type = 'pool'").all()
                .find(row => normalizeFilesystemPath(row.file_path) === resolved) || null;
            if (previous) {
                this.db.prepare('UPDATE file_records SET file_path = ? WHERE file_path = ?').run(resolved, previous.file_path);
                previous = { ...previous, file_path: resolved };
            }
        }
        let sha256 = knownHash;
        if (!sha256 && !forceHash && previous && previous.size === stat.size && Math.abs(previous.mtime_ms - stat.mtimeMs) < 1) {
            sha256 = previous.sha256;
        }
        if (!sha256) sha256 = await this.hashFile(resolved);
        return { stat, sha256, resolved };
    }

    findPotentialMovedRecord(sha256, currentPath) {
        currentPath = normalizeFilesystemPath(currentPath);
        const rows = this.db.prepare("SELECT * FROM file_records WHERE sha256 = ? AND source_type = 'pool'")
            .all(sha256).filter(row => normalizeFilesystemPath(row.file_path) !== currentPath);

        const missing = rows.filter(row => !fs.existsSync(normalizeFilesystemPath(row.file_path)));
        return missing.length === 1 ? { ...missing[0], file_path: normalizeFilesystemPath(missing[0].file_path) } : null;
    }

    async indexPoolFile(filePath, lightweightTags = {}, knownHash = '', forceRefresh = false) {
        const { stat, sha256, resolved } = await this.statAndHash(filePath, knownHash, forceRefresh);
        const old = this.db.prepare('SELECT * FROM file_records WHERE file_path = ?').get(resolved);
        const oldTags = old ? this.safeJson(old.metadata_json, {}) : {};
        const unchanged = !forceRefresh && old && old.size === stat.size && Math.abs(old.mtime_ms - stat.mtimeMs) < 1;

        const suppliedTags = unchanged && Number(oldTags._organizer_metadata_version) === 7
            ? oldTags
            : await this.readTags(resolved);
        const metadata = {
            ...suppliedTags,
            title: String(suppliedTags.title || '').trim(),
            artist: String(suppliedTags.artist || '').trim(),
            albumartist: String(suppliedTags.albumartist || '').trim(),
            album: String(suppliedTags.album || '').trim(),
            date: String(suppliedTags.date || '').trim(),
            originaldate: String(suppliedTags.originaldate || '').trim(),
            tracknumber: String(suppliedTags.tracknumber || ''),
            discnumber: String(suppliedTags.discnumber || ''),
            totaldiscs: String(suppliedTags.totaldiscs || ''),
            _extension: String(suppliedTags._extension || path.extname(resolved).slice(1).toLowerCase()),
            _organizer_metadata_version: 7
        };

        if (old && old.sha256 && old.sha256 !== sha256) {
            try {
                if (this.onCatalogPathChanged(resolved, resolved, metadata) === false) {
                    console.warn(`[Organizer] Pool file changed at ${resolved}, but catalog/library links could not be fully refreshed.`);
                }
            } catch (error) {
                console.warn(`[Organizer] Pool file changed at ${resolved}; link refresh failed: ${error.message}`);
            }
        }
        if (!old) {
            const movedRecord = this.findPotentialMovedRecord(sha256, resolved);
            if (movedRecord) {
                let catalogPathUpdated = true;
                try {
                    catalogPathUpdated = this.onCatalogPathChanged(movedRecord.file_path, resolved, metadata) !== false;
                } catch (error) {
                    catalogPathUpdated = false;
                    console.error('[Organizer] Catalog path update failed:', error.message);
                }
                if (catalogPathUpdated) {
                    this.db.prepare('DELETE FROM file_records WHERE file_path = ?').run(movedRecord.file_path);
                }
            }
        }
        this.db.prepare(`
            INSERT INTO file_records (file_path, sha256, size, mtime_ms, source_type, metadata_json, last_seen)
            VALUES (?, ?, ?, ?, 'pool', ?, ?)
            ON CONFLICT(file_path) DO UPDATE SET
                sha256=excluded.sha256, size=excluded.size, mtime_ms=excluded.mtime_ms,
                source_type='pool', metadata_json=excluded.metadata_json, last_seen=excluded.last_seen
        `).run(resolved, sha256, stat.size, stat.mtimeMs, JSON.stringify(metadata), Date.now());
        if (Array.isArray(this.poolCache)) {
            const hints = this.poolPathTags(resolved);
            const cacheTags = {
                ...hints, ...metadata,
                title: metadata.title || hints.title,
                artist: metadata.artist || hints.artist,
                albumartist: metadata.albumartist || metadata.artist || hints.albumartist,
                album: metadata.album || hints.album
            };
            const cached = { file_path: resolved, sha256, size: stat.size, mtime_ms: stat.mtimeMs, source_type: 'pool', metadata_json: JSON.stringify(metadata), tags: cacheTags };
            const cacheIndex = this.poolCache.findIndex(item => normalizeFilesystemPath(item.file_path) === resolved);
            const previous = cacheIndex >= 0 ? this.poolCache[cacheIndex] : null;
            if (cacheIndex >= 0) this.poolCache[cacheIndex] = cached;
            else this.poolCache.push(cached);
            if (this.poolTitleIndex) this.updatePoolTitleIndex(previous, cached);
        }
        return { sha256, size: stat.size, mtimeMs: stat.mtimeMs, tags: metadata };
    }

    updateFileRecordPath(fromPath, toPath, sourceType, sha256, size, mtimeMs, tags) {
        const from = normalizeFilesystemPath(fromPath);
        const to = normalizeFilesystemPath(toPath);
        let old = this.db.prepare('SELECT * FROM file_records WHERE file_path = ?').get(from);
        if (!old) old = this.db.prepare("SELECT * FROM file_records WHERE source_type IN ('pool', 'trash')").all()
            .find(row => normalizeFilesystemPath(row.file_path) === from) || null;
        if (old) this.db.prepare('DELETE FROM file_records WHERE file_path = ?').run(old.file_path);
        this.db.prepare(`
            INSERT OR REPLACE INTO file_records (file_path, sha256, size, mtime_ms, source_type, metadata_json, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(to, sha256 || (old && old.sha256) || '', size == null ? ((old && old.size) || 0) : size,
            mtimeMs == null ? ((old && old.mtime_ms) || 0) : mtimeMs, sourceType,
            JSON.stringify(tags || (old && JSON.parse(old.metadata_json || '{}')) || {}), Date.now());
    }

    queryPoolRecords() {
        return this.db.prepare("SELECT * FROM file_records WHERE source_type = 'pool'").all()
            .map(row => ({ ...row, file_path: normalizeFilesystemPath(row.file_path) }))
            .filter(row => fs.existsSync(row.file_path))
            .map(row => {
                const stored = this.safeJson(row.metadata_json, {});
                const hints = this.poolPathTags(row.file_path);
                return { ...row, tags: { ...hints, ...stored, title: stored.title || hints.title, artist: stored.artist || hints.artist, albumartist: stored.albumartist || stored.artist || hints.albumartist, album: stored.album || hints.album } };
            });
    }

    poolPathTags(filePath) {
        const title = cleanFilenameTitle(path.basename(filePath));
        const folder = path.basename(path.dirname(filePath));
        const parent = path.basename(path.dirname(path.dirname(filePath)));
        let artist = '';
        let album = '';
        const commonAlbumFolder = folder.match(/^(.+?)\s+-\s+\(?\d{4}\)?\s+(.+)$/);
        if (commonAlbumFolder) {
            artist = commonAlbumFolder[1].trim();
            album = commonAlbumFolder[2].trim();
        } else if (normalizeFilesystemPath(path.dirname(filePath)) !== this.poolDir && parent && parent !== path.basename(this.poolDir)) {
            artist = parent;
            album = folder;
        }
        return { title, artist, albumartist: artist, album };
    }

    poolRecords() {
        if (Array.isArray(this.poolCache)) return this.poolCache;
        return this.queryPoolRecords();
    }

    safeJson(value, fallback) {
        try { return JSON.parse(value || ''); } catch (_) { return fallback; }
    }

    exactPoolMatch(sha256, currentPath) {
        const current = normalizeFilesystemPath(currentPath);
        const rows = this.db.prepare("SELECT * FROM file_records WHERE sha256 = ? AND source_type = 'pool'").all(sha256);
        const match = rows.find(row => normalizeFilesystemPath(row.file_path) !== current && fs.existsSync(normalizeFilesystemPath(row.file_path)));
        return match ? { ...match, file_path: normalizeFilesystemPath(match.file_path) } : null;
    }

    scoreMetadata(candidate, target, candidateEmbedded = null) {

        const left = candidateEmbedded || candidate || {};
        const right = target || {};
        const compareText = (a, b) => {
            const first = normalized(a);
            const second = normalized(b);
            if (!first || !second) return null;
            return first === second ? 1 : fuzz.ratio(first, second) / 100;
        };

        const titleScore = compareText(left.title, right.title);

        if (titleScore === null || titleScore < 0.88) return 0;

        const leftArtist = left.albumartist || left.artist;
        const rightArtist = right.albumartist || right.artist;
        const artistScore = compareText(leftArtist, rightArtist);
        const albumScore = compareText(left.album, right.album);

        if (artistScore !== null && artistScore < 0.72) return 0;

        let supportScore = null;
        if (artistScore !== null && artistScore >= 0.72) {
            supportScore = artistScore;
        } else if (albumScore !== null && albumScore >= 0.82) {
            supportScore = albumScore;
        }
        if (supportScore === null) return 0;

        const parts = [{ score: titleScore, weight: 0.62 }];
        if (artistScore !== null) parts.push({ score: artistScore, weight: 0.30 });
        if (albumScore !== null) parts.push({ score: albumScore, weight: 0.08 });
        const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
        const score = parts.reduce((sum, part) => sum + part.score * part.weight, 0) / totalWeight;
        return Math.max(0, Math.min(1, score));
    }

    isSafeOverwriteMatch(candidate, target) {
        const left = candidate || {};
        const right = target || {};
        const sameText = (a, b) => {
            const first = normalized(a);
            const second = normalized(b);
            return !!first && !!second && first === second;
        };
        if (!left.title || !right.title || !sameText(left.title, right.title)) return false;
        const leftArtist = left.albumartist || left.artist;
        const rightArtist = right.albumartist || right.artist;
        if (!leftArtist || !rightArtist || !sameText(leftArtist, rightArtist)) return false;

        if (!left.album || !right.album || !sameText(left.album, right.album)) return false;
        const durationA = Number(left.duration);
        const durationB = Number(right.duration);
        if (Number.isFinite(durationA) && durationA > 0 && Number.isFinite(durationB) && durationB > 0 && Math.abs(durationA - durationB) > 8) {
            return false;
        }
        return true;
    }

    qualityProfile(filePath, tags = {}) {

        const pathExtension = path.extname(filePath || '').slice(1).toLowerCase();
        const extension = pathExtension || String(tags._extension || '').toLowerCase();
        const codec = String(tags._codec || '').toLowerCase();
        const bitrate = Number.parseInt(tags._bitrate, 10) || 0;
        const bitsPerSample = Number.parseInt(tags._bits_per_sample || tags._bit_depth, 10) || 0;
        const sampleRate = Number.parseInt(tags._sample_rate, 10) || 0;
        const isFlac = extension === 'flac' || codec.includes('flac');
        const isAlac = extension === 'alac' || codec.includes('alac');
        const isPcm = ['wav', 'aif', 'aiff'].includes(extension) || codec.includes('pcm');
        const isLossyCodec = extension === 'mp3' || codec.includes('mpeg layer 3')
            || extension === 'opus' || codec.includes('opus')
            || extension === 'ogg' || codec.includes('vorbis')
            || extension === 'aac' || codec.includes('aac') || extension === 'm4a';

        const losslessFlag = tags._lossless === true || tags._lossless === 1
            || String(tags._lossless || '').trim().toLowerCase() === 'true';
        const isOtherLossless = losslessFlag && !isLossyCodec;

        let tier = 1;
        if (isFlac) tier = 60;
        else if (isAlac) tier = 50;
        else if (isPcm) tier = 45;
        else if (isOtherLossless) tier = 40;
        else if (isLossyCodec) tier = 20;
        return {
            tier, bitrate, bitsPerSample, sampleRate, extension, codec,
            lossless: isFlac || isAlac || isPcm || isOtherLossless
        };
    }

    isBetterQualityVersion(candidatePath, candidateTags, targetPath, targetTags) {
        const candidate = this.qualityProfile(candidatePath, candidateTags);
        const target = this.qualityProfile(targetPath, targetTags);
        if (candidate.tier !== target.tier) return candidate.tier > target.tier;
        if (candidate.lossless && target.lossless && candidate.bitsPerSample && target.bitsPerSample
            && candidate.bitsPerSample !== target.bitsPerSample) {
            return candidate.bitsPerSample > target.bitsPerSample;
        }
        const lossyCodecFamily = profile => {
            if (profile.extension === 'mp3' || profile.codec.includes('mpeg layer 3')) return 'mp3';
            if (profile.extension === 'opus' || profile.codec.includes('opus')) return 'opus';
            if (profile.codec.includes('vorbis')) return 'vorbis';
            if (profile.extension === 'ogg') return `ogg:${profile.codec || 'unknown'}`;
            if (profile.extension === 'aac' || profile.codec.includes('aac')) return 'aac';
            if (profile.extension === 'm4a') return `m4a:${profile.codec || 'unknown'}`;
            return `${profile.extension}:${profile.codec || 'unknown'}`;
        };

        if (candidate.tier === 20 && target.tier === 20
            && lossyCodecFamily(candidate) === lossyCodecFamily(target)
            && candidate.bitrate && target.bitrate) {
            return candidate.bitrate >= target.bitrate + 24;
        }
        return false;
    }

    async removeDeadFileRecord(filePath) {
        const resolved = normalizeFilesystemPath(filePath);
        if (!fs.existsSync(resolved)) {
            const rows = this.db.prepare('SELECT file_path FROM file_records').all();
            const storedPath = rows.find(row => normalizeFilesystemPath(row.file_path) === resolved)?.file_path || resolved;
            this.db.prepare('DELETE FROM file_records WHERE file_path = ?').run(storedPath);
        }
    }

    async findCatalogReplacementForDeadTrack(track, candidatePaths = []) {
        const deadTags = {
            title: String(track.title || '').trim(),
            artist: String(track.artist || '').trim(),
            albumartist: String(track.artist || '').trim(),
            album: String(track.album || '').trim()
        };
        if (!normalized(deadTags.title) || !normalized(deadTags.artist) || normalized(deadTags.artist) === 'unknown') return null;

        const pathSet = new Set(candidatePaths.filter(Boolean).map(file => normalizeFilesystemPath(file)));
        for (const row of this.db.prepare("SELECT file_path FROM file_records WHERE source_type = 'pool'").all()) {
            const normalizedPath = normalizeFilesystemPath(row.file_path);
            if (fs.existsSync(normalizedPath)) pathSet.add(normalizedPath);
        }
        const deadPath = normalizeFilesystemPath(track.file_path || '');
        const matches = [];
        for (const candidatePath of pathSet) {
            if (!fs.existsSync(candidatePath) || normalizeFilesystemPath(candidatePath) === deadPath) continue;
            let candidateTags = {};
            try { candidateTags = await this.getEmbeddedMetadataForPath(candidatePath); } catch (_) {}
            const title = normalized(candidateTags.title);
            const artist = normalized(candidateTags.artist || candidateTags.albumartist);
            if (!title || title !== normalized(deadTags.title) || !artist || artist !== normalized(deadTags.artist)) continue;
            const oldAlbum = normalized(deadTags.album);
            const newAlbum = normalized(candidateTags.album);
            const albumMatches = !oldAlbum || oldAlbum === 'unknown' || !newAlbum || oldAlbum === newAlbum;
            const albumDiffers = !!oldAlbum && oldAlbum !== 'unknown' && !!newAlbum && oldAlbum !== newAlbum;
            matches.push({ path: candidatePath, tags: candidateTags, albumMatches, albumDiffers, profile: this.qualityProfile(candidatePath, candidateTags) });
        }
        if (!matches.length) return null;

        matches.sort((a, b) => b.profile.tier - a.profile.tier || b.profile.bitrate - a.profile.bitrate);
        const top = matches[0];
        const tied = matches.filter(item => item.profile.tier === top.profile.tier && item.profile.bitrate === top.profile.bitrate);
        if (tied.length !== 1) return null;
        return { path: top.path, tags: top.tags, albumMatches: top.albumMatches, albumDiffers: top.albumDiffers, format: top.profile.extension.toUpperCase(), confidence: top.albumMatches ? 1 : 0.86 };
    }

    rebuildPoolTitleIndex() {
        this.poolTitleIndex = new Map();
        for (const row of this.poolRecords()) {
            const titleKey = normalized(row.tags && row.tags.title);
            if (!titleKey) continue;
            if (!this.poolTitleIndex.has(titleKey)) this.poolTitleIndex.set(titleKey, []);
            this.poolTitleIndex.get(titleKey).push(row);
        }
    }

    updatePoolTitleIndex(previous, current) {
        if (!this.poolTitleIndex) return;
        if (previous) {
            const oldKey = normalized(previous.tags && previous.tags.title);
            const oldRows = oldKey ? this.poolTitleIndex.get(oldKey) : null;
            if (oldRows) {
                const filtered = oldRows.filter(row => normalizeFilesystemPath(row.file_path) !== normalizeFilesystemPath(previous.file_path));
                if (filtered.length) this.poolTitleIndex.set(oldKey, filtered);
                else this.poolTitleIndex.delete(oldKey);
            }
        }
        const newKey = normalized(current.tags && current.tags.title);
        if (newKey) {
            if (!this.poolTitleIndex.has(newKey)) this.poolTitleIndex.set(newKey, []);
            this.poolTitleIndex.get(newKey).push(current);
        }
    }

    bestPoolMatch(tags, filePath, candidateEmbedded = null, exactTitleOnly = false) {
        let best = null;
        let rows = this.poolRecords();
        const candidateTags = candidateEmbedded || tags || {};
        const candidateTitle = normalized(candidateTags.title);
        if (!candidateTitle) return null;

        if (exactTitleOnly) {
            if (!this.poolTitleIndex) this.rebuildPoolTitleIndex();
            rows = this.poolTitleIndex.get(candidateTitle) || [];
        }
        for (const row of rows) {
            if (normalizeFilesystemPath(row.file_path) === normalizeFilesystemPath(filePath)) continue;

            const targetTags = this.safeJson(row.metadata_json, {});
            if (!targetTags.title) continue;
            if (exactTitleOnly && normalized(targetTags.title) !== candidateTitle) continue;
            const score = this.scoreMetadata(candidateTags, targetTags, candidateTags);
            if (score >= 0.82 && score > (best ? best.confidence : 0)) {
                best = { path: row.file_path, confidence: score, tags: targetTags, sha256: row.sha256 };
            }
        }
        return best;
    }

    async normalizePendingReviewMatches() {

        const rows = this.db.prepare(`SELECT * FROM review_queue
            WHERE status = 'pending' AND matched_path IS NOT NULL
            AND kind IN ('low_match', 'similar', 'metadata', 'quality_upgrade')`).all();
        const metadataCache = new Map();
        for (const row of rows) {
            const candidatePath = fs.existsSync(row.candidate_path) ? row.candidate_path
                : (fs.existsSync(row.source_path) ? row.source_path : '');
            let embedded = this.safeJson(row.metadata_json, {});
            if (candidatePath && Number(embedded._organizer_metadata_version) !== 7) {
                try {
                    embedded = await this.readTags(candidatePath);
                    this.db.prepare('UPDATE review_queue SET metadata_json = ? WHERE id = ? AND status = \'pending\'')
                        .run(JSON.stringify(embedded), row.id);
                } catch (_) {}
            }
            let target = metadataCache.get(normalizeFilesystemPath(row.matched_path));
            if (!target) {
                try { target = await this.getEmbeddedMetadataForPath(row.matched_path); }
                catch (_) { target = {}; }
                metadataCache.set(normalizeFilesystemPath(row.matched_path), target || {});
            }
            const score = fs.existsSync(row.matched_path) ? this.scoreMetadata(embedded, target, embedded) : 0;
            if (score < 0.82) {
                const reason = 'A previous suggested pool match was removed because the embedded title and artist/album metadata do not support a meaningful match. Track/disc numbers and duration alone are not used to identify a song. The candidate has no linked comparison file.';
                this.db.prepare(`UPDATE review_queue SET matched_path = NULL, kind = 'metadata', confidence = 0, reason = ?
                    WHERE id = ? AND status = 'pending'`).run(reason, row.id);
            } else {
                let refreshedKind = row.kind;
                let refreshedReason = row.reason;
                if (candidatePath && fs.existsSync(row.matched_path)) {
                    const higherQuality = this.isBetterQualityVersion(candidatePath, embedded, row.matched_path, target || {});
                    if (higherQuality) {
                        refreshedKind = 'quality_upgrade';
                        refreshedReason = 'A higher-quality version of this track is available. The current pool version will be preserved in Trash if you approve the upgrade.';
                    } else if (row.kind === 'quality_upgrade') {
                        refreshedKind = 'similar';
                        refreshedReason = 'The audio metadata still resembles a track in the pool, but the candidate is not demonstrably higher quality. Compare both versions before choosing an action.';
                    }
                }
                this.db.prepare(`UPDATE review_queue SET confidence = ?, kind = ?, reason = ? WHERE id = ? AND status = 'pending'`)
                    .run(score, refreshedKind, refreshedReason || '', row.id);
            }
        }
    }
    async walkAudioFiles(rootPath, excludedPaths = []) {
        const results = [];
        const config = this.getScanConfig();
        const excludedRoots = [...excludedPaths, ...(config.trashFolder ? [config.trashFolder] : [])].map(item => normalizeFilesystemPath(item));
        const resolvedRoot = normalizeFilesystemPath(rootPath);
        async function walk(current) {
            let entries;
            try { entries = await fs.promises.readdir(current, { withFileTypes: true }); }
            catch (_) { return; }
            for (const entry of entries) {
                const target = normalizeFilesystemPath(current, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    if (excludedRoots.some(excluded => pathIsSameOrInside(target, excluded))) continue;
                    await walk(target);
                } else if (entry.isFile() && AUDIO_EXTENSIONS.test(entry.name)) {
                    results.push(target);
                }
            }
        }
        if (fs.existsSync(resolvedRoot) && fs.statSync(resolvedRoot).isDirectory()) await walk(resolvedRoot);
        return results;
    }

    alreadyPending(filePath) {
        const resolved = normalizeFilesystemPath(filePath);
        return !!this.db.prepare(`SELECT 1 FROM review_queue WHERE status = 'pending' AND
            (source_path = ? OR candidate_path = ?) LIMIT 1`).get(resolved, resolved);
    }

    isIgnoredUnchanged(filePath, stat) {
        const resolved = normalizeFilesystemPath(filePath);
        const row = this.db.prepare('SELECT * FROM ignored_paths WHERE path = ?').get(resolved);
        if (!row) return false;
        if (row.size === stat.size && Math.abs(row.mtime_ms - stat.mtimeMs) < 1) return true;
        this.db.prepare('DELETE FROM ignored_paths WHERE path = ?').run(resolved);
        return false;
    }

    queueReview(item) {
        const sourcePath = normalizeFilesystemPath(item.source_path);
        const candidatePath = normalizeFilesystemPath(item.candidate_path || item.source_path);
        const assignedUserId = Number.parseInt(item.assigned_user_id, 10);
        const validAssignedUserId = Number.isSafeInteger(assignedUserId) && assignedUserId > 0 ? assignedUserId : null;
        const assignmentWasProvided = Object.prototype.hasOwnProperty.call(item, 'assigned_user_id');
        const existing = this.db.prepare("SELECT id, assigned_user_id FROM review_queue WHERE status = 'pending' AND source_path = ? LIMIT 1").get(sourcePath);
        if (existing) {
            if (assignmentWasProvided && (Number(existing.assigned_user_id) || null) !== validAssignedUserId) {
                this.db.prepare("UPDATE review_queue SET assigned_user_id = ? WHERE id = ? AND status = 'pending'")
                    .run(validAssignedUserId, existing.id);
            }
            return existing.id;
        }
        const result = this.db.prepare(`
            INSERT INTO review_queue (
                source_path, candidate_path, matched_path, planned_path, kind, confidence, reason,
                metadata_json, tags_json, sha256, file_size, file_mtime_ms, assigned_user_id, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(sourcePath, candidatePath, item.matched_path ? normalizeFilesystemPath(item.matched_path) : null,
            item.planned_path ? normalizeFilesystemPath(item.planned_path) : null, item.kind, item.confidence || 0,
            item.reason || 'Needs administrator review.', JSON.stringify(item.embedded || {}), JSON.stringify(item.tags || {}),
            item.sha256 || '', item.file_size || 0, item.file_mtime_ms || 0, validAssignedUserId, Date.now());
        return Number(result.lastInsertRowid);
    }

    resolvedTrashFolder() {
        const { trashFolder } = this.getScanConfig();
        if (!trashFolder) return '';
        const resolved = normalizeFilesystemPath(trashFolder);
        if (resolved === this.poolDir || pathIsInside(this.poolDir, resolved)) return '';
        return resolved;
    }

    uniquePath(directory, filename) {
        const parsed = path.parse(filename);
        let candidate = normalizeFilesystemPath(directory, filename);
        let n = 2;
        while (fs.existsSync(candidate)) {
            candidate = normalizeFilesystemPath(directory, `${parsed.name} (${n})${parsed.ext}`);
            n++;
        }
        return candidate;
    }

    async moveFile(fromPath, toPath) {
        const from = normalizeFilesystemPath(fromPath);
        const to = normalizeFilesystemPath(toPath);
        if (!fs.existsSync(from)) throw new Error(`File not found: ${from}`);
        if (fs.existsSync(to)) throw new Error(`Destination already exists: ${to}`);
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        try {
            await fs.promises.rename(from, to);
        } catch (error) {
            if (error.code !== 'EXDEV') throw error;
            await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
            try { await fs.promises.unlink(from); }
            catch (unlinkError) {
                try { await fs.promises.unlink(to); } catch (_) {}
                throw unlinkError;
            }
        }
        return to;
    }

    async moveToTrash(filePath, sha256, tags) {
        const current = normalizeFilesystemPath(filePath);
        const trashRoot = this.resolvedTrashFolder();
        if (!trashRoot) return current;
        if (pathIsSameOrInside(current, trashRoot)) return current;
        const target = this.uniquePath(trashRoot, path.basename(current));
        const stat = await fs.promises.stat(current);
        await this.moveFile(current, target);
        this.updateFileRecordPath(current, target, 'trash', sha256, stat.size, stat.mtimeMs, tags);
        return target;
    }

    buildDestination(tags, sourcePath, renameFiles) {
        sourcePath = normalizeFilesystemPath(sourcePath);
        const settings = this.getSettings();

        const actualExtension = path.extname(sourcePath).slice(1).toLowerCase();
        const namingTags = { ...(tags || {}), _extension: actualExtension };
        const evaluated = evaluatePicardScript(settings.naming_script, namingTags);
        const normalizedSeparators = evaluated.replace(/\\/g, '/');
        const rawSegments = normalizedSeparators.split('/').filter(Boolean);
        if (!rawSegments.length || rawSegments.some(segment => segment === '.' || segment === '..')) {
            throw new Error('Naming script did not produce a safe, usable path. Check that artist, album, and title fields are present.');
        }
        const safeSegments = rawSegments.map(safeSegment);
        if (safeSegments.some(segment => !segment)) throw new Error('Naming script produced an empty or invalid path segment.');
        const extension = path.extname(sourcePath).toLowerCase();
        const originalName = path.basename(sourcePath);
        let directories;
        let filename;
        if (renameFiles) {
            directories = safeSegments.slice(0, -1);
            let name = safeSegments[safeSegments.length - 1];

            const scriptedExtension = name.match(/\.(mp3|flac|m4a|ogg|wav|opus|aac|wma|aiff|aif)$/i);
            if (scriptedExtension) name = name.slice(0, -scriptedExtension[0].length);
            filename = `${safeSegment(name)}${extension}`;
        } else {
            directories = safeSegments.slice(0, -1);
            filename = originalName;
        }
        if (!filename || filename === extension) throw new Error('Naming script did not produce a valid filename.');
        const destination = normalizeFilesystemPath(this.poolDir, ...directories, filename);
        if (!pathIsInside(destination, this.poolDir)) throw new Error('The naming script attempted to place a file outside the Master Pool.');
        const { dumpFolders, trashFolder } = this.getScanConfig();
        if (dumpFolders.some(folder => pathIsSameOrInside(destination, folder))) throw new Error('Naming script points into a configured dump folder.');
        if (trashFolder && pathIsSameOrInside(destination, trashFolder)) throw new Error('Naming script points into the trash folder.');
        return destination;
    }

    async processOne(filePath, dumpRoot, stats, assignedUserId = null) {
        const resolved = normalizeFilesystemPath(filePath);
        const parsedAssignedUserId = Number.parseInt(assignedUserId, 10);
        assignedUserId = Number.isSafeInteger(parsedAssignedUserId) && parsedAssignedUserId > 0
            ? parsedAssignedUserId : null;
        const queueReview = item => this.queueReview({ ...item, assigned_user_id: assignedUserId });
        const assignExistingPoolTrack = async (poolPath, poolTags = {}) => {
            if (!assignedUserId || !poolPath || !pathIsInside(poolPath, this.poolDir)
                || !fs.existsSync(poolPath) || !this.onPoolFileAdded) return;
            try {
                let tagsForPool = poolTags;
                if (!tagsForPool || typeof tagsForPool !== 'object' || !Object.keys(tagsForPool).length) {
                    tagsForPool = await this.getEmbeddedMetadataForPath(poolPath);
                }

                this.onPoolFileAdded(normalizeFilesystemPath(poolPath), tagsForPool || {}, { assignedUserId });
            } catch (error) {
                console.warn(`[Organizer] Could not assign matched dump song to user ${assignedUserId}: ${error.message}`);
            }
        };
        let stat;
        try { stat = await fs.promises.stat(resolved); }
        catch (_) { stats.skipped++; return; }
        if (this.isIgnoredUnchanged(resolved, stat)) {
            stats.skipped++;
            return;
        }
        if (this.alreadyPending(resolved)) {

            this.db.prepare(`UPDATE review_queue SET assigned_user_id = ?
                WHERE status = 'pending' AND (source_path = ? OR candidate_path = ?)`).run(assignedUserId, resolved, resolved);
            stats.skipped++;
            return;
        }

        const embedded = await this.readTags(resolved);
        const suggestions = pathSuggestedTags(resolved, dumpRoot);
        const tags = {
            ...embedded,
            title: embedded.title || suggestions.title,
            artist: embedded.artist || suggestions.artist,
            albumartist: embedded.albumartist || embedded.artist || suggestions.albumartist || suggestions.artist,
            album: embedded.album || suggestions.album,
            source_path_title: suggestions.title,
            source_path_artist: suggestions.artist,
            source_path_album: suggestions.album
        };

        let hashData;
        try { hashData = await this.statAndHash(resolved); }
        catch (error) {
            queueReview({ source_path: resolved, candidate_path: resolved, kind: 'error', reason: `Could not read file for identity check: ${error.message}`, embedded, tags, file_size: stat.size, file_mtime_ms: stat.mtimeMs });
            stats.review++;
            return;
        }
        const { sha256 } = hashData;

        const plannedPath = (() => {
            const renameFiles = this.getSettings().rename_files === '1';
            try { return this.buildDestination(embedded, resolved, renameFiles); }
            catch (_) {
                try { return this.buildDestination(tags, resolved, renameFiles); }
                catch (_) { return null; }
            }
        })();

        if (plannedPath && normalizeFilesystemPath(plannedPath) !== resolved && fs.existsSync(plannedPath)) {
            let targetRecord = this.poolRecords().find(row => normalizeFilesystemPath(row.file_path) === normalizeFilesystemPath(plannedPath));
            let targetHash = targetRecord && targetRecord.sha256;
            if (!targetHash) {
                try { targetHash = await this.hashFile(plannedPath); } catch (_) { targetHash = ''; }
            }
            if (targetHash && targetHash === sha256) {
                let candidatePath = resolved;
                try { candidatePath = await this.moveToTrash(resolved, sha256, tags); }
                catch (error) { console.error('[Organizer] Could not stage path-conflict duplicate in trash:', error.message); }
                queueReview({
                    source_path: resolved, candidate_path: candidatePath, matched_path: plannedPath,
                    planned_path: plannedPath, kind: 'duplicate', confidence: 1,
                    reason: candidatePath !== resolved && this.resolvedTrashFolder() && pathIsInside(candidatePath, this.resolvedTrashFolder())
                        ? 'The naming script destination already contains a byte-identical audio file. The candidate was staged in Trash for review.'
                        : 'The naming script destination contains a byte-identical audio file. The candidate remains at its current path because it could not be staged in Trash; review it before taking action.',
                    embedded, tags, sha256, file_size: stat.size, file_mtime_ms: stat.mtimeMs
                });
                await assignExistingPoolTrack(plannedPath, targetRecord && targetRecord.tags);
                stats.duplicates++;
                stats.review++;
                return;
            }
            let targetTags = targetRecord && targetRecord.tags;
            try { targetTags = await this.getEmbeddedMetadataForPath(plannedPath); }
            catch (_) { targetTags = targetTags || this.poolPathTags(plannedPath); }
            const confidence = this.scoreMetadata(embedded, targetTags, embedded);
            const meaningfulMatch = confidence >= 0.82;
            queueReview({
                source_path: resolved, candidate_path: resolved, matched_path: plannedPath,
                planned_path: plannedPath, kind: 'path_conflict', confidence,
                reason: meaningfulMatch
                    ? 'The naming-script destination is already occupied, and the embedded title/artist/album tags suggest this could be the same recording. The existing file was not overwritten.'
                    : 'The naming-script destination is already occupied, but the embedded metadata does not support identifying the existing file as the same song. Overwrite is blocked; choose Keep Both or leave the candidate in the dump.',
                embedded, tags, sha256, file_size: stat.size, file_mtime_ms: stat.mtimeMs
            });
            if (meaningfulMatch) await assignExistingPoolTrack(plannedPath, targetTags);
            stats.review++;
            return;
        }

        const exact = this.exactPoolMatch(sha256, resolved);
        if (exact) {
            let candidatePath = resolved;
            try { candidatePath = await this.moveToTrash(resolved, sha256, tags); }
            catch (error) { console.error('[Organizer] Could not stage exact duplicate in trash:', error.message); }
            queueReview({
                source_path: resolved, candidate_path: candidatePath, matched_path: exact.file_path,
                planned_path: plannedPath, kind: 'duplicate', confidence: 1,
                reason: candidatePath !== resolved && this.resolvedTrashFolder() && pathIsInside(candidatePath, this.resolvedTrashFolder())
                    ? 'The SHA-256 hash exactly matches an existing pool file at a different path. The candidate was staged in Trash for administrator review.'
                    : 'The SHA-256 hash exactly matches an existing pool file at a different path. The candidate remains at its current path because it could not be staged in Trash; review it before taking action.',
                embedded, tags, sha256, file_size: stat.size, file_mtime_ms: stat.mtimeMs
            });
            await assignExistingPoolTrack(exact.file_path, exact.tags);
            stats.duplicates++;
            stats.review++;
            return;
        }

        const hasFullEmbeddedTags = !!(embedded.title && (embedded.albumartist || embedded.artist) && embedded.album);
        if (!hasFullEmbeddedTags) {

            const best = this.bestPoolMatch(embedded, resolved, embedded);
            if (best && best.confidence >= 0.82) {
                const isQualityUpgrade = this.isBetterQualityVersion(resolved, embedded, best.path, best.tags || {});
                queueReview({
                    source_path: resolved, candidate_path: resolved, matched_path: best.path,
                    planned_path: plannedPath, kind: isQualityUpgrade ? 'quality_upgrade' : 'low_match', confidence: best.confidence,
                    reason: isQualityUpgrade
                        ? `A higher-quality ${path.extname(resolved).slice(1).toUpperCase()} version appears to match an existing pool track despite incomplete metadata. Review the comparison; the existing version will be preserved in Trash if you approve the upgrade.`
                        : 'Core embedded metadata is incomplete, but the title and supporting artist/album metadata indicate a possible existing track. Compare both files before approving, keeping both, or overwriting.',
                    embedded, tags, sha256, file_size: stat.size, file_mtime_ms: stat.mtimeMs
                });
                await assignExistingPoolTrack(best.path, best.tags);
                stats.review++;
                return;
            }
            const missing = [];
            if (!embedded.title) missing.push('title');
            if (!(embedded.albumartist || embedded.artist)) missing.push('artist/album artist');
            if (!embedded.album) missing.push('album');
            queueReview({
                source_path: resolved, candidate_path: resolved,
                matched_path: null,
                planned_path: plannedPath, kind: 'metadata', confidence: 0,
                reason: `Embedded metadata is incomplete (${missing.join(', ')}). The organizer checked the pool, but no strong enough match was found. Path and filename clues are for review only; this file will not enter the pool without admin approval.`,
                embedded, tags, sha256, file_size: stat.size, file_mtime_ms: stat.mtimeMs
            });
            stats.review++;
            return;
        }

        if (!plannedPath) {
            queueReview({
                source_path: resolved, candidate_path: resolved, matched_path: null,
                planned_path: null, kind: 'metadata', confidence: 0,
                reason: 'The naming script could not produce a valid destination. Check the embedded tags and naming script before approving.',
                embedded, tags, sha256, file_size: stat.size, file_mtime_ms: stat.mtimeMs
            });
            stats.review++;
            return;
        }

        const sameTitleMatch = this.bestPoolMatch(embedded, resolved, embedded, true);
        if (sameTitleMatch && sameTitleMatch.confidence >= 0.92) {
            const targetTags = sameTitleMatch.tags || await this.getEmbeddedMetadataForPath(sameTitleMatch.path);
            const isQualityUpgrade = this.isBetterQualityVersion(resolved, embedded, sameTitleMatch.path, targetTags);
            queueReview({
                source_path: resolved, candidate_path: resolved, matched_path: sameTitleMatch.path,
                planned_path: plannedPath, kind: isQualityUpgrade ? 'quality_upgrade' : 'similar', confidence: sameTitleMatch.confidence,
                reason: isQualityUpgrade
                    ? `A higher-quality ${path.extname(resolved).slice(1).toUpperCase()} version of this track was found. The existing pool version will be preserved in Trash if you approve the upgrade; the new version will use the naming-script destination.`
                    : 'A high-confidence embedded-metadata match exists at a different path, but the audio hash differs. This may be another encode or a legitimate version; compare both files before choosing Overwrite or Keep Both. The candidate was not moved automatically.',
                embedded, tags, sha256, file_size: stat.size, file_mtime_ms: stat.mtimeMs
            });
            await assignExistingPoolTrack(sameTitleMatch.path, targetTags);
            stats.review++;
            return;
        }

        try {
            const movedTo = await this.moveFile(resolved, plannedPath);
            const indexed = await this.indexPoolFile(movedTo, {}, sha256);
            this.onPoolFileAdded(movedTo, { ...tags, ...embedded }, { assignedUserId });
            stats.organized++;
            stats.bytes += indexed.size || stat.size;
        } catch (error) {
            queueReview({
                source_path: resolved, candidate_path: fs.existsSync(resolved) ? resolved : plannedPath,
                matched_path: null, planned_path: plannedPath, kind: 'error', confidence: 0,
                reason: `Organizer could not finish moving this file: ${error.message}`,
                embedded, tags, sha256, file_size: stat.size, file_mtime_ms: stat.mtimeMs
            });
            stats.errors++;
            stats.review++;
        }
    }

    async indexCurrentPool(files, options = {}, progressOffset = 0, total = files.length) {
        if (!fs.existsSync(this.poolDir) || !fs.statSync(this.poolDir).isDirectory()) {
            throw new Error(`Master Pool directory does not exist: ${this.poolDir}`);
        }
        for (let i = 0; i < files.length; i++) {
            const filePath = files[i];
            if (options.onProgress) options.onProgress({
                processed: progressOffset + i, total, stage: 'pool-index',
                message: `Hashing and reading embedded metadata from existing pool files: ${i + 1} / ${files.length}`,
                currentPath: filePath
            });
            try { await this.indexPoolFile(filePath); }
            catch (error) { console.warn(`[Organizer] Could not index pool identity for ${filePath}: ${error.message}`); }
            if (options.onProgress) options.onProgress({
                processed: progressOffset + i + 1, total, stage: 'pool-index',
                message: `Checked existing pool files: ${i + 1} / ${files.length}`,
                currentPath: filePath
            });
            if (i % 5 === 0) await new Promise(resolve => setImmediate(resolve));
        }
    }

    async processDumps(options = {}) {
        if (this.running) return { busy: true, message: 'Organizer is already running.' };
        this.running = true;
        const stats = { organized: 0, duplicates: 0, review: 0, skipped: 0, errors: 0, bytes: 0, processed: 0, total: 0 };
        try {
            const initialConfig = this.getScanConfig();
            if (!fs.existsSync(this.poolDir) || !fs.statSync(this.poolDir).isDirectory()) {
                throw new Error(`Master Pool directory does not exist: ${this.poolDir}`);
            }
            if (!initialConfig.dumpFolders.length) {
                if (options.onProgress) options.onProgress({ processed: 0, total: 0, stage: 'complete', message: 'No dump folders are configured.' });
                return stats;
            }

            const poolExcluded = [...initialConfig.dumpFolders, ...initialConfig.exemptFolders];
            const poolFiles = await this.walkAudioFiles(this.poolDir, poolExcluded);
            const dumpFiles = [];
            const seenDumpFiles = new Set();
            const seenRoots = new Set();
            const trashRoot = this.resolvedTrashFolder();
            for (const dumpRoot of initialConfig.dumpFolders) {
                const root = normalizeFilesystemPath(dumpRoot);
                if (seenRoots.has(root)) continue;

                if (root === this.poolDir || pathIsInside(this.poolDir, root) || (trashRoot && pathIsSameOrInside(root, trashRoot))) {
                    console.warn(`[Organizer] Skipping unsafe dump root: ${root}`);
                    continue;
                }
                seenRoots.add(root);
                if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
                const files = await this.walkAudioFiles(root);
                for (const file of files) {
                    const resolved = normalizeFilesystemPath(file);
                    if (!seenDumpFiles.has(resolved)) {
                        seenDumpFiles.add(resolved);
                        dumpFiles.push(resolved);
                    }
                }
            }

            stats.total = poolFiles.length + dumpFiles.length;
            if (options.onProgress) options.onProgress({
                processed: 0, total: stats.total, stage: 'prepare',
                message: `Found ${poolFiles.length} existing pool files and ${dumpFiles.length} dump files. Preparing identity checks...`
            });
            await this.indexCurrentPool(poolFiles, options, 0, stats.total);
            stats.processed = poolFiles.length;
            this.poolCache = this.queryPoolRecords();
            this.rebuildPoolTitleIndex();

            const configuredDumpEntries = Array.isArray(initialConfig.dumpFolderEntries)
                ? initialConfig.dumpFolderEntries
                : initialConfig.dumpFolders.map(folder => ({ path: folder, user_id: null }));
            for (let i = 0; i < dumpFiles.length; i++) {
                const filePath = dumpFiles[i];

                const matchingDumpEntries = configuredDumpEntries
                    .filter(entry => pathIsSameOrInside(filePath, entry.path))
                    .sort((a, b) => normalizeFilesystemPath(b.path).length - normalizeFilesystemPath(a.path).length);
                const matchedDumpEntry = matchingDumpEntries[0] || null;
                const dumpRoot = matchedDumpEntry ? matchedDumpEntry.path : path.dirname(filePath);
                const assignedUserId = matchedDumpEntry ? matchedDumpEntry.user_id : null;
                if (options.onProgress) options.onProgress({
                    processed: poolFiles.length + i, total: stats.total, stage: 'dump-process',
                    message: `Reading metadata and hashing dump files before destination checks: ${i + 1} / ${dumpFiles.length}`,
                    currentPath: filePath
                });
                await this.processOne(filePath, dumpRoot, stats, assignedUserId);
                stats.processed = poolFiles.length + i + 1;
                if (options.onProgress) options.onProgress({
                    ...stats, stage: 'dump-process',
                    message: `Organizing dump files: ${i + 1} / ${dumpFiles.length}`,
                    currentPath: filePath
                });
                if (i % 5 === 0) await new Promise(resolve => setImmediate(resolve));
            }
            return stats;
        } finally {
            this.running = false;
            this.poolCache = null;
            this.poolTitleIndex = null;
        }
    }

    async getEmbeddedMetadataForPath(filePath) {
        const resolved = normalizeFilesystemPath(filePath);
        let record = this.db.prepare('SELECT file_path, metadata_json, sha256, source_type FROM file_records WHERE file_path = ?').get(resolved);
        if (!record) {
            record = this.db.prepare('SELECT file_path, metadata_json, sha256, source_type FROM file_records').all()
                .find(row => normalizeFilesystemPath(row.file_path) === resolved) || null;
        }
        let tags = this.safeJson(record && record.metadata_json, {});
        if (fs.existsSync(resolved) && Number(tags._organizer_metadata_version) !== 7) {
            try {
                tags = await this.readTags(resolved);
                if (record && record.source_type === 'pool') {
                    this.db.prepare('UPDATE file_records SET file_path = ?, metadata_json = ?, last_seen = ? WHERE file_path = ?')
                        .run(resolved, JSON.stringify(tags), Date.now(), record.file_path);
                }
            } catch (_) {}
        } else if (record && record.source_type === 'pool' && record.file_path !== resolved) {
            try { this.db.prepare('UPDATE file_records SET file_path = ? WHERE file_path = ?').run(resolved, record.file_path); }
            catch (_) {}
        }
        return tags;
    }

    async refreshPendingReviewDestinations() {
        const rows = this.db.prepare("SELECT * FROM review_queue WHERE status = 'pending' AND kind IN ('metadata', 'low_match', 'similar', 'quality_upgrade')").all();
        const renameFiles = this.getSettings().rename_files === '1';
        for (const row of rows) {
            const candidatePath = fs.existsSync(row.candidate_path) ? normalizeFilesystemPath(row.candidate_path)
                : (fs.existsSync(row.source_path) ? normalizeFilesystemPath(row.source_path) : '');
            if (!candidatePath) continue;
            let embedded = this.safeJson(row.metadata_json, {});
            if (Number(embedded._organizer_metadata_version) !== 7) {
                try {
                    embedded = await this.readTags(candidatePath);
                    this.db.prepare("UPDATE review_queue SET metadata_json = ? WHERE id = ? AND status = 'pending'")
                        .run(JSON.stringify(embedded), row.id);
                } catch (_) {}
            }
            const tags = this.safeJson(row.tags_json, {});
            let plannedPath = null;

            try { plannedPath = this.buildDestination(embedded, candidatePath, renameFiles); }
            catch (_) {
                try { plannedPath = this.buildDestination(tags, candidatePath, renameFiles); }
                catch (_) { plannedPath = null; }
            }
            this.db.prepare("UPDATE review_queue SET planned_path = ? WHERE id = ? AND status = 'pending'")
                .run(plannedPath, row.id);
        }
    }

    async autoApprovePendingMetadataWithoutConflicts(createdSince = 0) {
        await this.refreshPendingReviewDestinations();
        const cutoff = Math.max(0, Number(createdSince) || 0);
        const rows = this.db.prepare(`SELECT id, source_path, candidate_path, matched_path, planned_path, created_at
            FROM review_queue
            WHERE status = 'pending' AND kind = 'metadata' AND matched_path IS NULL
              AND planned_path IS NOT NULL AND created_at >= ?
            ORDER BY created_at ASC, id ASC`).all(cutoff);
        if (!rows.length) return { approved: 0, skipped: 0 };

        const config = this.getScanConfig();
        const allPendingTargets = this.db.prepare(`SELECT id, planned_path FROM review_queue
            WHERE status = 'pending' AND planned_path IS NOT NULL`).all();
        const targetCounts = new Map();
        const pathKey = value => {
            const resolved = normalizeFilesystemPath(value);
            return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        };
        for (const row of allPendingTargets) {
            const key = pathKey(row.planned_path);
            targetCounts.set(key, (targetCounts.get(key) || 0) + 1);
        }

        let approved = 0;
        let skipped = 0;
        for (const row of rows) {
            const candidatePath = fs.existsSync(row.candidate_path) ? normalizeFilesystemPath(row.candidate_path)
                : (fs.existsSync(row.source_path) ? normalizeFilesystemPath(row.source_path) : '');
            const destination = normalizeFilesystemPath(row.planned_path);
            const key = pathKey(destination);
            const safeDestination = pathIsInside(destination, this.poolDir)
                && !config.dumpFolders.some(folder => pathIsSameOrInside(destination, folder))
                && !(config.trashFolder && pathIsSameOrInside(destination, config.trashFolder));

            if (!candidatePath || !safeDestination || fs.existsSync(destination)
                || (targetCounts.get(key) || 0) > 1) {
                skipped++;
                continue;
            }
            try {
                const result = await this.resolveReview(row.id, 'approve');
                if (result && result.success) approved++;
                else skipped++;
            } catch (error) {
                skipped++;
                console.warn(`[Organizer] Scheduled metadata approval skipped for review #${row.id}: ${error.message}`);
            }
        }
        return { approved, skipped };
    }

    async getPendingReviews(options = {}) {
        await this.normalizePendingReviewMatches();
        await this.refreshPendingReviewDestinations();
        const kind = String(options.kind || 'all');
        const search = String(options.search || '').trim();
        let page = Math.max(1, Number.parseInt(options.page, 10) || 1);
        const limit = Math.max(10, Math.min(100, Number.parseInt(options.limit, 10) || 25));
        const allowedKinds = new Set(['duplicate', 'path_conflict', 'quality_upgrade', 'similar', 'low_match', 'metadata', 'error']);
        const conditions = ["status = 'pending'"];
        const params = [];
        if (allowedKinds.has(kind)) {
            conditions.push('kind = ?');
            params.push(kind);
        }
        if (search) {
            conditions.push(`(source_path LIKE ? OR candidate_path LIKE ? OR COALESCE(matched_path, '') LIKE ? OR COALESCE(planned_path, '') LIKE ? OR reason LIKE ? OR metadata_json LIKE ? OR tags_json LIKE ?)`);
            const q = `%${search}%`;
            params.push(q, q, q, q, q, q, q);
        }
        const location = String(options.location || 'all');
        const trashRootForFilter = this.resolvedTrashFolder();
        if (location === 'trash') {
            if (!trashRootForFilter) conditions.push('1 = 0');
            else {
                const prefix = `${trashRootForFilter}${path.sep}`;
                conditions.push('substr(candidate_path, 1, length(?)) = ?');
                params.push(prefix, prefix);
            }
        } else if (location === 'outside_trash' && trashRootForFilter) {
            const prefix = `${trashRootForFilter}${path.sep}`;
            conditions.push('substr(candidate_path, 1, length(?)) != ?');
            params.push(prefix, prefix);
        }
        const where = conditions.join(' AND ');
        const pendingCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM review_queue WHERE status = 'pending'").get().count || 0);
        const filteredCount = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM review_queue WHERE ${where}`).get(...params).count || 0);
        const pages = Math.max(1, Math.ceil(filteredCount / limit));
        page = Math.min(page, pages);
        const rows = this.db.prepare(`SELECT * FROM review_queue WHERE ${where} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`)
            .all(...params, limit, (page - 1) * limit);
        const trashRoot = this.resolvedTrashFolder();
        const items = [];
        for (const row of rows) {
            const tags = this.safeJson(row.tags_json, {});
            let embedded = this.safeJson(row.metadata_json, {});
            const currentCandidatePath = fs.existsSync(row.candidate_path)
                ? normalizeFilesystemPath(row.candidate_path)
                : (fs.existsSync(row.source_path) ? normalizeFilesystemPath(row.source_path) : '');
            if (currentCandidatePath && Number(embedded._organizer_metadata_version) !== 7) {
                try {
                    embedded = await this.readTags(currentCandidatePath);
                    this.db.prepare("UPDATE review_queue SET metadata_json = ?, file_size = ?, file_mtime_ms = ? WHERE id = ? AND status = 'pending'")
                        .run(JSON.stringify(embedded), fs.statSync(currentCandidatePath).size, fs.statSync(currentCandidatePath).mtimeMs, row.id);
                } catch (_) {}
            }

            let kindValue = row.kind;
            let matchedPath = row.matched_path;
            let confidence = Number(row.confidence || 0);
            let reason = row.reason;
            let matchedMetadata = {};
            let matchedExists = !!(matchedPath && fs.existsSync(matchedPath));
            let matchIsMeaningful = false;
            if (matchedExists) {
                const resolvedMatch = normalizeFilesystemPath(matchedPath);
                matchedMetadata = await this.getEmbeddedMetadataForPath(resolvedMatch);
                const directScore = this.scoreMetadata(embedded, matchedMetadata, embedded);
                matchIsMeaningful = directScore >= 0.82;

                if (['low_match', 'similar', 'metadata'].includes(kindValue) && !matchIsMeaningful) {
                    matchedPath = null;
                    matchedMetadata = {};
                    matchedExists = false;
                    kindValue = 'metadata';
                    confidence = 0;
                    reason = 'The previous suggested pool match was removed because the embedded title and artist/album metadata do not support a meaningful match. Track/disc numbers and duration alone are not used to identify a song.';
                    this.db.prepare(`UPDATE review_queue SET matched_path = NULL, kind = 'metadata', confidence = 0, reason = ?
                        WHERE id = ? AND status = 'pending'`).run(reason, row.id);
                } else if (matchIsMeaningful) {
                    confidence = directScore;
                }
            } else if (matchedPath && ['low_match', 'similar', 'metadata'].includes(kindValue)) {
                matchedPath = null;
                kindValue = 'metadata';
                confidence = 0;
                matchedMetadata = {};
                reason = 'The previously suggested pool file no longer exists, so it is no longer shown as a comparison target. Review the candidate metadata before approving it.';
                this.db.prepare(`UPDATE review_queue SET matched_path = NULL, kind = 'metadata', confidence = 0, reason = ?
                    WHERE id = ? AND status = 'pending'`).run(reason, row.id);
            }
            const candidateInTrash = !!(trashRoot && pathIsInside(row.candidate_path, trashRoot));
            const sameExtension = !!(matchedPath && path.extname(row.candidate_path || row.source_path).toLowerCase() === path.extname(matchedPath).toLowerCase());

            const canOverwrite = !!(matchedPath && matchedExists && sameExtension && (
                kindValue === 'duplicate' || matchIsMeaningful || this.isSafeOverwriteMatch(embedded, matchedMetadata)
            ));
            const isQualityUpgrade = kindValue === 'quality_upgrade' && !!(matchedPath && matchedExists && this.isBetterQualityVersion(currentCandidatePath || row.candidate_path, embedded, matchedPath, matchedMetadata));
            items.push({
                id: row.id,
                kind: kindValue,
                source_path: row.source_path,
                candidate_path: row.candidate_path,
                matched_path: matchedPath,
                planned_path: row.planned_path,
                confidence,
                reason,
                tags,
                embedded,
                matched_metadata: matchedMetadata,
                match_is_meaningful: matchIsMeaningful || kindValue === 'duplicate',
                can_overwrite: canOverwrite,
                is_quality_upgrade: isQualityUpgrade,
                sha256: row.sha256,
                candidate_exists: fs.existsSync(row.candidate_path),
                candidate_in_trash: candidateInTrash,
                matched_exists: matchedExists,
                created_at: row.created_at
            });
        }
        return { items, count: pendingCount, filteredCount, page, limit, pages };
    }

    async getPendingReviewIds(options = {}) {
        await this.normalizePendingReviewMatches();
        await this.refreshPendingReviewDestinations();
        const kind = String(options.kind || 'all');
        const search = String(options.search || '').trim();
        const allowedKinds = new Set(['duplicate', 'path_conflict', 'quality_upgrade', 'similar', 'low_match', 'metadata', 'error']);
        const conditions = ["status = 'pending'"];
        const params = [];
        if (allowedKinds.has(kind)) { conditions.push('kind = ?'); params.push(kind); }
        if (search) {
            conditions.push(`(source_path LIKE ? OR candidate_path LIKE ? OR COALESCE(matched_path, '') LIKE ? OR COALESCE(planned_path, '') LIKE ? OR reason LIKE ? OR metadata_json LIKE ? OR tags_json LIKE ?)`);
            const q = `%${search}%`;
            params.push(q, q, q, q, q, q, q);
        }
        const location = String(options.location || 'all');
        const trashRootForFilter = this.resolvedTrashFolder();
        if (location === 'trash') {
            if (!trashRootForFilter) conditions.push('1 = 0');
            else {
                const prefix = `${trashRootForFilter}${path.sep}`;
                conditions.push('substr(candidate_path, 1, length(?)) = ?');
                params.push(prefix, prefix);
            }
        } else if (location === 'outside_trash' && trashRootForFilter) {
            const prefix = `${trashRootForFilter}${path.sep}`;
            conditions.push('substr(candidate_path, 1, length(?)) != ?');
            params.push(prefix, prefix);
        }
        return this.db.prepare(`SELECT id FROM review_queue WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC, id ASC`).all(...params).map(row => row.id);
    }

    reviewRow(id) {
        const row = this.db.prepare("SELECT * FROM review_queue WHERE id = ? AND status = 'pending'").get(Number(id));
        if (!row) throw new Error('Review item was not found or has already been resolved.');
        return row;
    }

    markResolved(id, action) {
        this.db.prepare("UPDATE review_queue SET status = 'resolved', action = ?, resolved_at = ? WHERE id = ?")
            .run(action, Date.now(), Number(id));
    }

    async resolveReview(id, action) {
        const row = this.reviewRow(id);
        const config = this.getScanConfig();
        const trashRoot = this.resolvedTrashFolder();
        let candidatePath = normalizeFilesystemPath(row.candidate_path);
        if (!fs.existsSync(candidatePath)) {
            if (fs.existsSync(row.source_path)) candidatePath = normalizeFilesystemPath(row.source_path);
            else throw new Error('The review candidate file no longer exists at its recorded path.');
        }
        const tags = this.safeJson(row.tags_json, {});
        const embedded = this.safeJson(row.metadata_json, {});
        const hash = row.sha256 || await this.hashFile(candidatePath);
        const stat = await fs.promises.stat(candidatePath);

        if (action === 'stage_trash') {
            if (!trashRoot) throw new Error('Configure a valid Trash folder in Scan Settings before staging this candidate.');
            if (pathIsInside(candidatePath, trashRoot)) {
                return { success: true, message: 'The candidate is already inside the configured trash folder.' };
            }
            const movedCandidate = await this.moveToTrash(candidatePath, hash, tags);
            this.db.prepare("UPDATE review_queue SET candidate_path = ?, sha256 = ? WHERE id = ? AND status = 'pending'")
                .run(movedCandidate, hash, Number(id));
            return { success: true, message: 'The candidate was moved into the configured trash folder. Review its available actions again.' };
        }

        if (action === 'delete') {
            if (!trashRoot || !pathIsInside(candidatePath, trashRoot)) {
                throw new Error('For safety, files can only be deleted when they are physically inside the configured trash folder. Move the candidate into trash first.');
            }
            await fs.promises.unlink(candidatePath);
            this.db.prepare('DELETE FROM file_records WHERE file_path = ?').run(candidatePath);
            this.markResolved(id, 'delete');
            return { success: true, message: 'The candidate file was deleted from the configured trash folder.' };
        }

        if (action === 'keep_dump') {
            if (trashRoot && pathIsInside(candidatePath, trashRoot)) {
                throw new Error('This candidate is already in Trash. Use Delete, Keep Both, or Overwrite instead of Keep in Dump.');
            }
            this.db.prepare(`INSERT OR REPLACE INTO ignored_paths (path, size, mtime_ms, reason, added_at) VALUES (?, ?, ?, ?, ?)`)
                .run(candidatePath, stat.size, stat.mtimeMs, 'Kept in dump by administrator', Date.now());
            this.markResolved(id, 'keep_dump');
            return { success: true, message: 'The file will remain in the dump and will not be re-queued unless its size or modification time changes.' };
        }

        if (!['overwrite', 'keep_both', 'approve', 'upgrade'].includes(action)) throw new Error('Unsupported review action.')
        if (action === 'approve' && row.matched_path) {
            throw new Error('This review item has an existing pool match or destination conflict. Choose Keep Both to organize it separately, or Overwrite Pool Song to replace the matched file safely.');
        }

        let destination;
        let targetToReplace = null;
        let targetMetadata = {};
        if (action === 'overwrite' || action === 'upgrade') {
            if (!row.matched_path || !fs.existsSync(row.matched_path)) throw new Error('The matched pool file no longer exists. Run a master scan and review again.');
            if (!trashRoot) throw new Error('Configure a trash folder before replacing a pool version: the existing pool file must be preserved there first.');
            if (pathIsInside(row.matched_path, trashRoot)) throw new Error('The matched path is in trash, not in the pool.');
            const currentCandidateHash = await this.hashFile(candidatePath);
            const currentTargetHash = await this.hashFile(row.matched_path);
            const candidateMetadata = await this.readTags(candidatePath);
            targetMetadata = await this.getEmbeddedMetadataForPath(row.matched_path);
            const metadataConfidence = this.scoreMetadata(candidateMetadata, targetMetadata, candidateMetadata);
            if (currentCandidateHash !== currentTargetHash && !this.isSafeOverwriteMatch(candidateMetadata, targetMetadata) && metadataConfidence < 0.82) {
                throw new Error('Overwrite blocked: the embedded title and artist/album metadata do not support a meaningful match. Keep Both or leave the candidate in the dump.');
            }
            if (action === 'overwrite') {
                if (path.extname(candidatePath).toLowerCase() !== path.extname(row.matched_path).toLowerCase()) {
                    throw new Error('The candidate and matched song use different file extensions. Use Upgrade Pool Version for a verified higher-quality encoding, or Keep Both.');
                }
                destination = normalizeFilesystemPath(row.matched_path);
            } else {
                if (metadataConfidence < 0.92 || !this.isBetterQualityVersion(candidatePath, candidateMetadata, row.matched_path, targetMetadata)) {
                    throw new Error('Upgrade blocked: the candidate must be a strong metadata match and demonstrably higher quality than the existing pool version.');
                }
                destination = row.planned_path && pathIsInside(row.planned_path, this.poolDir)
                    ? normalizeFilesystemPath(row.planned_path)
                    : this.buildDestination({ ...tags, ...candidateMetadata }, candidatePath, this.getSettings().rename_files === '1');
                if (normalizeFilesystemPath(destination) === normalizeFilesystemPath(row.matched_path)) {
                    destination = this.uniquePath(path.dirname(destination), path.basename(destination));
                }
                if (fs.existsSync(destination)) {
                    throw new Error(`Upgrade destination is already occupied: ${destination}. Review that path conflict separately before upgrading.`);
                }
            }
            targetToReplace = normalizeFilesystemPath(row.matched_path);
        } else {
            try {
                destination = row.planned_path && pathIsInside(row.planned_path, this.poolDir) && !pathIsSameOrInside(row.planned_path, config.trashFolder || path.join(this.poolDir, '__no_trash__'))
                    ? normalizeFilesystemPath(row.planned_path)
                    : this.buildDestination(tags, candidatePath, this.getSettings().rename_files === '1');
            } catch (_) {
                destination = this.buildDestination(tags, candidatePath, this.getSettings().rename_files === '1');
            }
            if (action === 'keep_both') {
                destination = this.uniquePath(path.dirname(destination), `${path.parse(destination).name} (kept both)${path.extname(destination)}`);
            } else if (fs.existsSync(destination)) {

                destination = this.uniquePath(path.dirname(destination), path.basename(destination));
            }
        }

        if (!pathIsInside(destination, this.poolDir)) throw new Error('The selected destination is outside the Master Pool.');
        const dumpRoots = config.dumpFolders;
        if (dumpRoots.some(root => pathIsSameOrInside(destination, root))) throw new Error('The selected destination is inside a configured dump folder.');
        if (trashRoot && pathIsSameOrInside(destination, trashRoot)) throw new Error('The selected destination is inside the trash folder.');

        let candidateInTrash = !!(trashRoot && pathIsInside(candidatePath, trashRoot));
        if (!candidateInTrash) {
            if (!trashRoot && action === 'overwrite') throw new Error('Configure a trash folder before overwriting.');
            if (trashRoot) {
                candidatePath = await this.moveToTrash(candidatePath, hash, tags);
                candidateInTrash = true;
                this.db.prepare("UPDATE review_queue SET candidate_path = ?, sha256 = ? WHERE id = ? AND status = 'pending'")
                    .run(candidatePath, hash, Number(id));
            } else if (!['approve', 'keep_both'].includes(action)) {
                throw new Error('Configure a trash folder to safely complete this action.');
            }
        }

        let oldTargetTrash = null;
        let oldTargetStat = null;
        let oldTargetRecord = null;
        if (targetToReplace) {
            oldTargetStat = await fs.promises.stat(targetToReplace);
            oldTargetRecord = this.db.prepare('SELECT * FROM file_records WHERE file_path = ?').get(targetToReplace);
            oldTargetTrash = this.uniquePath(trashRoot, path.basename(targetToReplace));
            await this.moveFile(targetToReplace, oldTargetTrash);
            this.updateFileRecordPath(targetToReplace, oldTargetTrash, 'trash', oldTargetRecord && oldTargetRecord.sha256,
                oldTargetStat.size, oldTargetStat.mtimeMs, oldTargetRecord ? this.safeJson(oldTargetRecord.metadata_json, {}) : targetMetadata);
            if (action === 'overwrite') destination = targetToReplace;
        } else if (fs.existsSync(destination)) {
            throw new Error('Destination already exists. No file was overwritten.');
        }

        try {
            await this.moveFile(candidatePath, destination);
        } catch (error) {
            if (oldTargetTrash && fs.existsSync(oldTargetTrash) && !fs.existsSync(targetToReplace)) {
                try {
                    await this.moveFile(oldTargetTrash, targetToReplace);
                    this.updateFileRecordPath(oldTargetTrash, targetToReplace, 'pool', '', null, null, targetMetadata);
                } catch (rollbackError) {
                    throw new Error(`${error.message}. The previous pool file remains safely in trash at ${oldTargetTrash}; rollback failed: ${rollbackError.message}`);
                }
            }
            throw error;
        }

        const finalStat = await fs.promises.stat(destination);
        this.updateFileRecordPath(candidatePath, destination, 'pool', hash, finalStat.size, finalStat.mtimeMs, embedded);
        const indexed = await this.indexPoolFile(destination, {}, hash);
        if ((action === 'upgrade' || action === 'overwrite') && targetToReplace && this.onCatalogPathChanged) {

            const catalogPathUpdated = this.onCatalogPathChanged(targetToReplace, destination, embedded) !== false;
            if (!catalogPathUpdated) {
                throw new Error(`The replacement file is in place at ${destination}, and the old version is safe in Trash, but the catalog or user-library links could not be fully updated. Please rescan the pool.`);
            }
        }
        this.onPoolFileAdded(destination, { ...embedded, ...tags }, {
            assignedUserId: Number(row.assigned_user_id) > 0 ? Number(row.assigned_user_id) : null
        });
        this.markResolved(id, action);
        return {
            success: true,
            message: action === 'overwrite'
                ? `Replaced the matched pool file. The previous version was preserved in trash at ${oldTargetTrash}.`
                : action === 'upgrade'
                    ? `Upgraded the pool to the higher-quality version at ${destination}. The previous version was preserved in Trash at ${oldTargetTrash}, and the catalog path was updated.`
                    : `Approved and organized the file into ${destination}.`,
            destination,
            sha256: indexed.sha256
        };
    }
}

Organizer.DEFAULT_NAMING_SCRIPT = DEFAULT_NAMING_SCRIPT;
Organizer.evaluatePicardScript = evaluatePicardScript;
Organizer.pathIsInside = pathIsInside;
module.exports = Organizer;
