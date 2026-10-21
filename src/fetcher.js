// Bypass strict TLS inspection errors from local firewall/proxies (identical to Eris)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
    if (typeof warning === 'string' && warning.includes('NODE_TLS_REJECT_UNAUTHORIZED')) return;
    return originalEmitWarning.call(process, warning, ...args);
};

const axios = require('axios');
const config = require('./config');
const nationsCache = require('./nationsCache');

let syncInterval = null;
let isSyncing = false;
let syncStatus = {
    isSyncing: false,
    lastSyncTime: null,
    lastSyncDurationMs: 0,
    totalNationsCached: 0,
    lastError: null,
    currentPage: 0,
    totalPages: 0,
};

const NATIONS_QUERY = `
query ($page: Int!) {
  nations(first: 50, page: $page) {
    paginatorInfo {
      hasMorePages
      currentPage
      lastPage
      total
    }
    data {
      id
      nation_name
      score
      color
      num_cities
      vacation_mode_turns
      beige_turns
      alliance_id
      alliance_position
      aircraft
      ships
      missiles
      nukes
      spies
      alliance {
        id
        name
      }
      wars(active: true) {
        id
        def_id
      }
      cities {
        id
        infrastructure
        land
      }
    }
  }
}
`;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sweeps Politics & War GraphQL API with page-level resume capability.
 * Updates current in-progress snapshot and finalizes full run on completion.
 */
async function syncNations(options = {}) {
    if (isSyncing) {
        console.log('[Fetcher] Sync already in progress, skipping trigger.');
        return syncStatus;
    }

    const apiKey = options.apiKey || config.pnwApiKey;
    if (!apiKey || apiKey === 'your_pnw_api_key_here') {
        console.warn('[Fetcher] Cannot sync: PNW_API_KEY is not configured or is placeholder.');
        syncStatus.lastError = 'PNW_API_KEY is missing';
        return syncStatus;
    }

    const pageDelay = options.pageDelayMs || config.pageDelayMs || 600;
    const url = `https://api.politicsandwar.com/graphql?api_key=${apiKey}`;

    isSyncing = true;
    syncStatus.isSyncing = true;
    syncStatus.lastError = null;
    const startTime = Date.now();

    // Check resume state
    const resumeState = nationsCache.getResumeState();
    let page = 1;

    if (resumeState.hasProgress) {
        page = resumeState.nextPage;
        console.log(`[Fetcher] 🔄 RESUMING sweep from page ${page} (recovered ${resumeState.accumulatedCount} nations from last run)...`);
    } else {
        nationsCache.resetCurrentForFreshSweep();
        console.log('[Fetcher] 🚀 Starting Politics & War data sweep from page 1...');
    }

    let hasMorePages = true;
    let totalSyncedThisSession = 0;

    try {
        while (hasMorePages) {
            syncStatus.currentPage = page;
            let response = null;
            let retries = 0;
            const maxRetries = 3;

            while (retries < maxRetries) {
                try {
                    response = await axios.post(
                        url,
                        {
                            query: NATIONS_QUERY,
                            variables: { page },
                        },
                        {
                            headers: { 'Content-Type': 'application/json' },
                            timeout: 25000,
                        }
                    );

                    // Check if response was intercepted by an enterprise network firewall
                    if (typeof response?.data === 'string' && response.data.includes('<html')) {
                        console.warn('[Fetcher] Politics & War API is blocked by local network firewall/proxy.');
                        console.warn('[Fetcher] Serving targets from local cache.');
                        return syncStatus;
                    }

                    break;
                } catch (err) {
                    // Check if request was blocked by network firewall (HTTP 403 / HTML block)
                    if (err.response?.status === 403 || (typeof err.response?.data === 'string' && err.response.data.includes('<html'))) {
                        console.warn('[Fetcher] Politics & War API is blocked on current network (Firewall / Network filter block).');
                        console.warn('[Fetcher] Serving targets from local cache.');
                        return syncStatus;
                    }

                    retries++;
                    const msg = err.response?.data?.message || err.message;
                    console.warn(`[Fetcher] Request issue on page ${page} (Attempt ${retries}/${maxRetries}): ${msg}`);
                    if (retries >= maxRetries) throw err;
                    await sleep(2000 * retries);
                }
            }

            if (response?.data?.errors && response.data.errors.length > 0) {
                const errMsg = response.data.errors.map(e => e.message).join('; ');
                throw new Error(`GraphQL Error: ${errMsg}`);
            }

            const nationsData = response?.data?.data?.nations;
            if (!nationsData) {
                console.warn(`[Fetcher] No nations returned on page ${page}. Ending current sweep pass.`);
                break;
            }

            const paginatorInfo = nationsData.paginatorInfo || {};
            syncStatus.totalPages = paginatorInfo.lastPage || page;
            hasMorePages = Boolean(paginatorInfo.hasMorePages);

            const rawNations = nationsData.data || [];
            if (rawNations.length === 0) {
                break;
            }

            const processedBatch = [];

            for (const nation of rawNations) {
                const nationIdStr = String(nation.id);

                // Active defensive wars where def_id matches nation ID
                const defWars = Array.isArray(nation.wars)
                    ? nation.wars.filter(w => w && String(w.def_id) === nationIdStr).length
                    : 0;

                // City structure
                const cities = Array.isArray(nation.cities)
                    ? nation.cities.map(c => ({
                        id: c.id,
                        infra: Number(c.infrastructure || 0),
                        land: Number(c.land || c.infrastructure || 0),
                    }))
                    : [];

                const record = {
                    id: nationIdStr,
                    nation_name: nation.nation_name || `Nation #${nation.id}`,
                    alliance_id: String(nation.alliance_id || '0'),
                    alliance_name: nation.alliance?.name || (nation.alliance_id && nation.alliance_id !== '0' ? `Alliance #${nation.alliance_id}` : 'No Alliance'),
                    alliance_position: String(nation.alliance_position || 'MEMBER'),
                    score: Number(nation.score || 0),
                    num_cities: Number(nation.num_cities || cities.length || 0),
                    color: nation.color || 'gray',
                    beige_turns: Number(nation.beige_turns || 0),
                    vacation_mode_turns: Number(nation.vacation_mode_turns || 0),
                    defensive_wars_count: defWars,
                    aircraft: Number(nation.aircraft || 0),
                    ships: Number(nation.ships || 0),
                    nukes: Number(nation.nukes || 0),
                    spies: Number(nation.spies || 0),
                    missiles: Number(nation.missiles || 0),
                    cities,
                    last_updated: Date.now(),
                };

                processedBatch.push(record);
            }

            // Save progress of current page immediately with atomic disk write
            nationsCache.saveCurrentProgress(page, paginatorInfo.lastPage, processedBatch);
            totalSyncedThisSession += processedBatch.length;

            if (page % 10 === 0 || !hasMorePages || (paginatorInfo.lastPage && page >= paginatorInfo.lastPage)) {
                console.log(`[Fetcher] Progress: Page ${page}/${paginatorInfo.lastPage || '?'} (+${totalSyncedThisSession} nations this session)`);
            }

            // Check if final page reached
            if (!hasMorePages || (paginatorInfo.lastPage && page >= paginatorInfo.lastPage)) {
                nationsCache.finalizeFullRun(paginatorInfo.lastPage);
                break;
            }

            page++;
            await sleep(pageDelay);
        }

        const duration = Date.now() - startTime;
        syncStatus.lastSyncTime = Date.now();
        syncStatus.lastSyncDurationMs = duration;
        syncStatus.totalNationsCached = nationsCache.getNationCount();
        console.log(`[Fetcher] Sweep session finished in ${(duration / 1000).toFixed(1)}s. Total available nations: ${syncStatus.totalNationsCached}`);
    } catch (err) {
        console.error('[Fetcher] Sweep halted (non-fatal, progress saved):', err.message);
        syncStatus.lastError = err.message;
    } finally {
        isSyncing = false;
        syncStatus.isSyncing = false;
    }

    return syncStatus;
}

/**
 * Starts background interval timer for periodic syncing.
 */
function startPeriodicFetcher(intervalMinutes = config.fetchIntervalMinutes, pageDelayMs = config.pageDelayMs) {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }

    const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
    console.log(`[Fetcher] Periodic fetcher initialized (Sweep interval: every ${intervalMinutes}m).`);

    // Trigger sweep (or resume) in background
    syncNations({ pageDelayMs }).catch(err => {
        console.error('[Fetcher] Error during initial sync:', err.message);
    });

    syncInterval = setInterval(() => {
        syncNations({ pageDelayMs }).catch(err => {
            console.error('[Fetcher] Error during scheduled sync:', err.message);
        });
    }, intervalMs);

    if (syncInterval.unref) syncInterval.unref();
}

/**
 * Stops periodic sync timer.
 */
function stopPeriodicFetcher() {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
        console.log('[Fetcher] Periodic fetcher stopped.');
    }
}

function getSyncStatus() {
    return {
        ...syncStatus,
        totalNationsCached: nationsCache.getNationCount(),
    };
}

module.exports = {
    syncNations,
    startPeriodicFetcher,
    stopPeriodicFetcher,
    getSyncStatus,
};
