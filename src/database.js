const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

let db = null;
let currentDbPath = config.databasePath;

/**
 * Creates a safe, synchronous backup copy of the current database.
 */
function createBackup(dbPath = currentDbPath) {
    if (!db) return;
    try {
        const resolvedPath = path.resolve(dbPath);
        const backupPath = `${resolvedPath}.bak`;

        // Checkpoint WAL journal into the main DB file before taking snapshot
        try {
            db.pragma('wal_checkpoint(TRUNCATE)');
        } catch (_) {}

        if (fs.existsSync(resolvedPath)) {
            fs.copyFileSync(resolvedPath, backupPath);
        }
    } catch (err) {
        console.warn('[Database] Failed to create backup:', err.message);
    }
}

/**
 * Initializes and connects to SQLite database with automatic corruption recovery.
 */
function initDatabase(dbPath = config.databasePath) {
    if (db) return db;

    const resolvedPath = path.resolve(dbPath);
    currentDbPath = resolvedPath;

    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const backupPath = `${resolvedPath}.bak`;

    function attemptOpen(targetPath) {
        const instance = new Database(targetPath);
        instance.pragma('journal_mode = WAL');
        instance.pragma('synchronous = NORMAL');

        // Run SQLite integrity check
        const check = instance.prepare('PRAGMA integrity_check').get();
        if (check && check.integrity_check !== 'ok') {
            instance.close();
            throw new Error(`Integrity check failed: ${check.integrity_check}`);
        }

        // Create coalitions table
        instance.exec(`
            CREATE TABLE IF NOT EXISTS coalitions (
                guild_id TEXT NOT NULL,
                name TEXT NOT NULL,
                alliance_ids TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (guild_id, name)
            );
        `);

        return instance;
    }

    try {
        db = attemptOpen(resolvedPath);
        console.log(`[Database] SQLite connected successfully for coalitions at: ${resolvedPath}`);
    } catch (err) {
        console.error(`[Database CORRUPTION ALERT] Error opening database: ${err.message}`);

        // Quarantine corrupted database file
        try {
            if (fs.existsSync(resolvedPath)) {
                const corruptedPath = `${resolvedPath}.corrupted.${Date.now()}`;
                fs.renameSync(resolvedPath, corruptedPath);
                if (fs.existsSync(`${resolvedPath}-wal`)) fs.renameSync(`${resolvedPath}-wal`, `${corruptedPath}-wal`);
                if (fs.existsSync(`${resolvedPath}-shm`)) fs.renameSync(`${resolvedPath}-shm`, `${corruptedPath}-shm`);
                console.warn(`[Database] Quarantined corrupted database to: ${path.basename(corruptedPath)}`);
            }
        } catch (renameErr) {
            console.error('[Database] Failed to quarantine corrupt database file:', renameErr.message);
        }

        // Attempt self-healing from backup
        if (fs.existsSync(backupPath)) {
            try {
                console.log('[Database] Self-healing: Restoring database from backup file...');
                fs.copyFileSync(backupPath, resolvedPath);
                db = attemptOpen(resolvedPath);
                console.log('[Database] Successfully restored database from backup!');
            } catch (healErr) {
                console.error('[Database] Backup restoration failed, initializing clean database:', healErr.message);
                try { fs.unlinkSync(resolvedPath); } catch (_) {}
                db = attemptOpen(resolvedPath);
            }
        } else {
            console.warn('[Database] No backup found. Initializing fresh SQLite database.');
            try { fs.unlinkSync(resolvedPath); } catch (_) {}
            db = attemptOpen(resolvedPath);
        }
    }

    // Create a fresh backup on successful boot
    createBackup(resolvedPath);

    return db;
}

/**
 * Ensures DB is initialized
 */
function getDb() {
    if (!db) {
        return initDatabase();
    }
    return db;
}

/**
 * Normalizes alliance IDs string or array into a clean comma-separated list of digits
 */
function normalizeAllianceIds(input) {
    if (!input) return '';
    let raw = '';
    if (Array.isArray(input)) {
        raw = input.join(',');
    } else {
        raw = String(input);
    }
    const ids = raw
        .split(',')
        .map(s => s.trim().replace(/\D/g, ''))
        .filter(s => s.length > 0);
    return Array.from(new Set(ids)).join(', ');
}

/**
 * Saves or updates a coalition for a guild with auto-backup.
 */
function saveCoalition(guildId, name, allianceIds) {
    const database = getDb();
    const cleanGuildId = String(guildId).trim();
    const cleanName = String(name).trim().toLowerCase();
    const cleanAllianceIds = normalizeAllianceIds(allianceIds);

    if (!cleanGuildId || !cleanName || !cleanAllianceIds) {
        throw new Error('Guild ID, coalition name, and at least one valid alliance ID are required.');
    }

    const stmt = database.prepare(`
        INSERT INTO coalitions (guild_id, name, alliance_ids, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, name) DO UPDATE SET
            alliance_ids = excluded.alliance_ids,
            updated_at = excluded.updated_at
    `);

    stmt.run(cleanGuildId, cleanName, cleanAllianceIds, Date.now());

    // Trigger backup
    createBackup();

    return { guild_id: cleanGuildId, name: cleanName, alliance_ids: cleanAllianceIds };
}

/**
 * Deletes a coalition by name for a guild with auto-backup.
 */
function deleteCoalition(guildId, name) {
    const database = getDb();
    const cleanGuildId = String(guildId).trim();
    const cleanName = String(name).trim().toLowerCase();

    const stmt = database.prepare(`
        DELETE FROM coalitions
        WHERE guild_id = ? AND name = ?
    `);

    const result = stmt.run(cleanGuildId, cleanName);
    if (result.changes > 0) {
        createBackup();
    }
    return result.changes > 0;
}

/**
 * Gets a coalition by name for a guild.
 */
function getCoalition(guildId, name) {
    const database = getDb();
    const cleanGuildId = String(guildId).trim();
    const cleanName = String(name).trim().toLowerCase();

    const stmt = database.prepare(`
        SELECT guild_id, name, alliance_ids, updated_at
        FROM coalitions
        WHERE guild_id = ? AND name = ?
    `);

    return stmt.get(cleanGuildId, cleanName) || null;
}

/**
 * Lists all coalitions registered for a guild.
 */
function listCoalitions(guildId) {
    const database = getDb();
    const cleanGuildId = String(guildId).trim();

    const stmt = database.prepare(`
        SELECT guild_id, name, alliance_ids, updated_at
        FROM coalitions
        WHERE guild_id = ?
        ORDER BY name ASC
    `);

    return stmt.all(cleanGuildId);
}

/**
 * Closes the database safely.
 */
function closeDatabase() {
    if (db) {
        createBackup();
        db.close();
        db = null;
        console.log('[Database] SQLite connection closed.');
    }
}

module.exports = {
    initDatabase,
    getDb,
    normalizeAllianceIds,
    saveCoalition,
    deleteCoalition,
    getCoalition,
    listCoalitions,
    createBackup,
    closeDatabase,
};
