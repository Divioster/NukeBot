const fs = require('fs');
const path = require('path');
const config = require('./config');

let currentCache = {
    status: 'pending',
    currentPage: 0,
    totalPages: 0,
    lastUpdated: null,
    nations: {},
};

let backupCache = {
    completedAt: null,
    totalPages: 0,
    totalNations: 0,
    nations: {},
};

/**
 * Helper to safely parse a JSON file from disk.
 */
function tryReadJsonFile(targetPath) {
    try {
        if (!fs.existsSync(targetPath)) return null;
        const stat = fs.statSync(targetPath);
        if (stat.size === 0) return null;

        const raw = fs.readFileSync(targetPath, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

/**
 * Atomically writes data to disk with fsync and backup rotation.
 */
function atomicWriteJson(filePath, data) {
    try {
        const resolvedPath = path.resolve(filePath);
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const backupPath = `${resolvedPath}.bak`;
        const tempPath = `${resolvedPath}.tmp.${Date.now()}`;

        const serialized = JSON.stringify(data, null, 2);

        // 1. Write to temporary file and flush to disk
        const fd = fs.openSync(tempPath, 'w');
        fs.writeSync(fd, serialized);
        fs.fsyncSync(fd);
        fs.closeSync(fd);

        // 2. Verify temporary file is parseable
        const testParse = tryReadJsonFile(tempPath);
        if (!testParse || typeof testParse !== 'object') {
            console.error(`[Cache] Integrity failure on temp write for ${path.basename(filePath)}. Aborting.`);
            try { fs.unlinkSync(tempPath); } catch (_) {}
            return false;
        }

        // 3. Rotate working file to .bak if it exists
        if (fs.existsSync(resolvedPath)) {
            try {
                fs.copyFileSync(resolvedPath, backupPath);
            } catch (_) {}
        }

        // 4. Atomically rename temp file
        fs.renameSync(tempPath, resolvedPath);
        return true;
    } catch (err) {
        console.error(`[Cache] Failed to atomic-write ${filePath}:`, err.message);
        return false;
    }
}

/**
 * Safely loads a cache file with auto-quarantine and .bak self-healing.
 */
function safeLoadCacheFile(filePath, label) {
    const resolvedPath = path.resolve(filePath);
    const backupPath = `${resolvedPath}.bak`;

    if (fs.existsSync(resolvedPath)) {
        const parsed = tryReadJsonFile(resolvedPath);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }

        // Corrupted file detected: quarantine
        console.warn(`[Cache CORRUPTION ALERT] ${label} file at ${resolvedPath} is corrupted or invalid.`);
        try {
            const corruptedPath = `${resolvedPath}.corrupted.${Date.now()}`;
            fs.renameSync(resolvedPath, corruptedPath);
            console.warn(`[Cache] Quarantined corrupted ${label} file to: ${path.basename(corruptedPath)}`);
        } catch (renameErr) {
            console.error(`[Cache] Failed to quarantine corrupt ${label}:`, renameErr.message);
        }
    }

    // Try recovering from .bak file
    if (fs.existsSync(backupPath)) {
        console.log(`[Cache] Self-healing: Attempting recovery of ${label} from backup file...`);
        const backupParsed = tryReadJsonFile(backupPath);
        if (backupParsed && typeof backupParsed === 'object') {
            try {
                fs.copyFileSync(backupPath, resolvedPath);
                console.log(`[Cache] Successfully restored ${label} from backup file.`);
                return backupParsed;
            } catch (healErr) {
                console.error(`[Cache] Failed to restore ${label} from backup:`, healErr.message);
            }
        }
    }

    return null;
}

/**
 * Loads both Current in-progress cache and Full Backup cache into memory on startup.
 */
function loadCache() {
    // 1. Load Full Completed Backup Cache
    const loadedBackup = safeLoadCacheFile(config.nationsBackupPath, 'Backup Cache');
    if (loadedBackup && typeof loadedBackup === 'object') {
        backupCache = {
            completedAt: loadedBackup.completedAt || null,
            totalPages: loadedBackup.totalPages || 0,
            totalNations: loadedBackup.totalNations || Object.keys(loadedBackup.nations || {}).length,
            nations: loadedBackup.nations || {},
        };
        console.log(`[Nations Cache] Loaded FULL BACKUP run: ${Object.keys(backupCache.nations).length} nations.`);
    }

    // 2. Load Current In-Progress Cache
    const loadedCurrent = safeLoadCacheFile(config.nationsCurrentPath, 'Current Cache');
    if (loadedCurrent && typeof loadedCurrent === 'object') {
        currentCache = {
            status: loadedCurrent.status || 'in_progress',
            currentPage: loadedCurrent.currentPage || 0,
            totalPages: loadedCurrent.totalPages || 0,
            lastUpdated: loadedCurrent.lastUpdated || null,
            nations: loadedCurrent.nations || {},
        };
        console.log(`[Nations Cache] Loaded CURRENT run: page ${currentCache.currentPage}/${currentCache.totalPages || '?'} (${Object.keys(currentCache.nations).length} nations in current sweep).`);
    }

    return { current: currentCache, backup: backupCache };
}

/**
 * Returns current resume state for fetcher.
 */
function getResumeState() {
    const hasProgress = (
        currentCache.currentPage > 0 &&
        currentCache.status === 'in_progress' &&
        (currentCache.totalPages === 0 || currentCache.currentPage < currentCache.totalPages)
    );

    return {
        hasProgress,
        status: currentCache.status,
        currentPage: currentCache.currentPage || 0,
        totalPages: currentCache.totalPages || 0,
        nextPage: (currentCache.currentPage || 0) + 1,
        accumulatedCount: Object.keys(currentCache.nations || {}).length,
    };
}

/**
 * Resets the current progress cache for a fresh scheduled sweep.
 */
function resetCurrentForFreshSweep() {
    currentCache = {
        status: 'in_progress',
        currentPage: 0,
        totalPages: 0,
        lastUpdated: Date.now(),
        nations: {},
    };
    atomicWriteJson(config.nationsCurrentPath, currentCache);
}

/**
 * Progressively saves a newly fetched page of nations into currentCache.
 * Allows the bot to restart exactly from page `page + 1` if interrupted.
 */
function saveCurrentProgress(page, totalPages, newBatch) {
    if (!currentCache.nations) currentCache.nations = {};

    if (Array.isArray(newBatch)) {
        for (const nation of newBatch) {
            if (nation && nation.id) {
                currentCache.nations[String(nation.id)] = nation;
            }
        }
    }

    currentCache.currentPage = Number(page);
    currentCache.totalPages = Number(totalPages || currentCache.totalPages || page);
    currentCache.status = 'in_progress';
    currentCache.lastUpdated = Date.now();

    atomicWriteJson(config.nationsCurrentPath, currentCache);
}

/**
 * Finalizes a complete sweep run: saves all nations into nations_backup.json
 * and marks currentCache as completed.
 */
function finalizeFullRun(totalPages) {
    const nationsCount = Object.keys(currentCache.nations || {}).length;

    // Safety Alert: Do not overwrite full backup if current run has 0 nations
    if (nationsCount === 0 && Object.keys(backupCache.nations || {}).length > 0) {
        console.warn('[Nations Cache SAFETY ALERT] Current sweep finished with 0 nations. Aborting backup overwrite to protect data.');
        return;
    }

    // Update Backup Cache (Full run snapshot)
    backupCache = {
        completedAt: Date.now(),
        totalPages: totalPages || currentCache.totalPages,
        totalNations: nationsCount,
        nations: { ...currentCache.nations },
    };
    atomicWriteJson(config.nationsBackupPath, backupCache);

    // Mark Current as completed and reset page pointer for next sweep
    currentCache.status = 'completed';
    currentCache.currentPage = 0;
    currentCache.lastUpdated = Date.now();
    atomicWriteJson(config.nationsCurrentPath, currentCache);

    console.log(`[Nations Cache] Full run finalized! ${nationsCount} nations saved to backup cache.`);
}

/**
 * Queries nations with comprehensive merging:
 * Overlays newly swept current nations onto the full completed backup run,
 * so commanders always query a complete dataset even during an active sweep.
 */
function getNations(filters = {}) {
    // Merge: backup nations + current nations (current overrides backup with freshest data)
    const combinedMap = {
        ...(backupCache.nations || {}),
        ...(currentCache.nations || {}),
    };

    const all = Object.values(combinedMap);
    if (all.length === 0) return [];

    return all.filter(nation => {
        // Score filter
        const score = Number(nation.score || 0);
        if (filters.min_score !== undefined && filters.min_score !== null && !isNaN(filters.min_score)) {
            if (score < Number(filters.min_score)) return false;
        }
        if (filters.max_score !== undefined && filters.max_score !== null && !isNaN(filters.max_score)) {
            if (score > Number(filters.max_score)) return false;
        }

        // Open defensive wars (< 3 defensive wars)
        if (filters.has_open_defensives) {
            if ((Number(nation.defensive_wars_count) || 0) >= 3) return false;
        }

        // Beige protection filter
        if (!filters.include_beige) {
            const beigeTurns = Number(nation.beige_turns || 0);
            const color = String(nation.color || '').toLowerCase();
            if (beigeTurns > 0 || color === 'beige') return false;
        }

        // Vacation mode filter (always exclude unless explicitly allowed)
        if (!filters.include_vacation) {
            if (Number(nation.vacation_mode_turns || 0) > 0) return false;
        }

        // Applicants filter
        if (!filters.include_applicants) {
            const pos = String(nation.alliance_position || '').toUpperCase();
            if (pos === 'APPLICANT' || pos === '1') return false;
        }

        // Alliance IDs filter (exact match list)
        if (Array.isArray(filters.alliance_ids) && filters.alliance_ids.length > 0) {
            const aId = String(nation.alliance_id || '0');
            if (!filters.alliance_ids.includes(aId)) return false;
        } else if (filters.alliance_query) {
            const q = String(filters.alliance_query).trim().toLowerCase();
            const aId = String(nation.alliance_id || '0');
            const aName = String(nation.alliance_name || '').toLowerCase();
            if (aId !== q && !aName.includes(q)) return false;
        }

        // Vital Defense System filter (default: true -> all nations; if false -> exclude nations with VDS)
        if (filters.has_vds === false) {
            if (checkNationHasVds(nation)) return false;
        }

        // Iron Dome filter (default: true -> all nations; if false -> exclude nations with Iron Dome)
        if (filters.has_iron_dome === false || filters.has_ironedome === false) {
            if (checkNationHasIronDome(nation)) return false;
        }

        return true;
    });
}

/**
 * Checks whether a nation possesses the Vital Defense System project.
 */
function checkNationHasVds(nation) {
    if (!nation) return false;
    if (nation.vital_defense_system !== undefined && nation.vital_defense_system !== null) {
        return Boolean(nation.vital_defense_system);
    }
    if (nation.project_bits !== undefined && nation.project_bits !== null && String(nation.project_bits) !== '0') {
        try {
            const str = String(nation.project_bits).trim();
            const b = (str.includes('e') || str.includes('E')) ? BigInt(Math.round(Number(str))) : BigInt(str);
            return ((b >> 9n) & 1n) === 1n; // Vital Defense System is index 9 (bit 9)
        } catch (_) {}
    }
    if (Array.isArray(nation.projects)) {
        return nation.projects.includes('Vital Defense System') || nation.projects.includes('vital_defense_system') || nation.projects.includes('VDS');
    }
    return false;
}

/**
 * Checks whether a nation possesses the Iron Dome project.
 */
function checkNationHasIronDome(nation) {
    if (!nation) return false;
    if (nation.iron_dome !== undefined && nation.iron_dome !== null) {
        return Boolean(nation.iron_dome);
    }
    if (nation.project_bits !== undefined && nation.project_bits !== null && String(nation.project_bits) !== '0') {
        try {
            const str = String(nation.project_bits).trim();
            const b = (str.includes('e') || str.includes('E')) ? BigInt(Math.round(Number(str))) : BigInt(str);
            return ((b >> 8n) & 1n) === 1n; // Iron Dome is index 8 (bit 8)
        } catch (_) {}
    }
    if (Array.isArray(nation.projects)) {
        return nation.projects.includes('Iron Dome') || nation.projects.includes('iron_dome');
    }
    return false;
}

/**
 * Returns total count of unique nations across combined cache.
 */
function getNationCount() {
    const combinedMap = {
        ...(backupCache.nations || {}),
        ...(currentCache.nations || {}),
    };
    return Object.keys(combinedMap).length;
}

/**
 * Returns timestamp of last update.
 */
function getLastUpdated() {
    return currentCache.lastUpdated || backupCache.completedAt;
}

/**
 * Direct access to cache objects (for testing / inspection)
 */
function getRawCaches() {
    return { current: currentCache, backup: backupCache };
}

// Initial load on module require
loadCache();

module.exports = {
    loadCache,
    getResumeState,
    resetCurrentForFreshSweep,
    saveCurrentProgress,
    finalizeFullRun,
    getNations,
    getNationCount,
    getLastUpdated,
    getRawCaches,
    checkNationHasVds,
    checkNationHasIronDome,
};
