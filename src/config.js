const path = require('path');
require('dotenv').config();

function cleanEnv(val, fallback = '') {
    if (!val) return fallback;
    const str = String(val).trim();
    return str.replace(/^["']|["']$/g, '').trim();
}

const config = {
    // Discord Configuration
    discordToken: cleanEnv(process.env.DISCORD_TOKEN),
    clientId: cleanEnv(process.env.CLIENT_ID),
    guildId: cleanEnv(process.env.GUILD_ID),

    // Politics & War API
    pnwApiKey: cleanEnv(process.env.PNW_API_KEY),

    // Fetcher Configuration
    fetchIntervalMinutes: Math.max(1, parseInt(cleanEnv(process.env.FETCH_INTERVAL_MINUTES), 10) || 15),
    pageDelayMs: Math.max(100, parseInt(cleanEnv(process.env.PAGE_DELAY_MS), 10) || 600),

    // Database Configuration (SQLite strictly for server coalitions)
    databasePath: cleanEnv(process.env.DATABASE_PATH)
        ? path.resolve(process.cwd(), cleanEnv(process.env.DATABASE_PATH))
        : path.resolve(process.cwd(), 'data', 'nukebot.db'),

    // Cache Paths (split into Current progress and Full completed Backup)
    nationsCurrentPath: cleanEnv(process.env.NATIONS_CURRENT_PATH)
        ? path.resolve(process.cwd(), cleanEnv(process.env.NATIONS_CURRENT_PATH))
        : path.resolve(process.cwd(), 'data', 'nations_current.json'),

    nationsBackupPath: cleanEnv(process.env.NATIONS_BACKUP_PATH)
        ? path.resolve(process.cwd(), cleanEnv(process.env.NATIONS_BACKUP_PATH))
        : path.resolve(process.cwd(), 'data', 'nations_backup.json'),

    nationsJsonPath: cleanEnv(process.env.NATIONS_JSON_PATH)
        ? path.resolve(process.cwd(), cleanEnv(process.env.NATIONS_JSON_PATH))
        : path.resolve(process.cwd(), 'data', 'nations_current.json'),

    // Visual Styling
    embedColor: '#39FF14', // Radioactive neon green
};

function validateConfig() {
    const missing = [];
    if (!config.discordToken || config.discordToken === 'your_discord_bot_token_here') missing.push('DISCORD_TOKEN');
    if (!config.clientId || config.clientId === 'your_discord_client_id_here') missing.push('CLIENT_ID');
    if (!config.pnwApiKey || config.pnwApiKey === 'your_pnw_api_key_here') missing.push('PNW_API_KEY');

    if (missing.length > 0) {
        console.warn(`[WARN] Missing or default placeholder environment variables: ${missing.join(', ')}`);
        console.warn('[WARN] Please configure them in your .env file before running in production.');
    }
}

module.exports = {
    ...config,
    cleanEnv,
    validateConfig,
};
