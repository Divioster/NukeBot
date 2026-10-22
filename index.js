// Bypass strict TLS inspection errors from local firewall/proxies (identical to Eris)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
    if (typeof warning === 'string' && warning.includes('NODE_TLS_REJECT_UNAUTHORIZED')) return;
    return originalEmitWarning.call(process, warning, ...args);
};

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    Events,
} = require('discord.js');
const config = require('./src/config');
const database = require('./src/database');
const fetcher = require('./src/fetcher');
const nationsCache = require('./src/nationsCache');

const targetFinderCommand = require('./src/commands/targetFinder');
const coalitionCommand = require('./src/commands/coalition');

// ==============================================================
// PROCESS-LEVEL ERROR HANDLERS (Identical to Eris)
// Prevents the bot from ever crashing on unhandled exceptions/rejections
// ==============================================================
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Uncaught Exception:');
    console.error(err?.message || err);
    console.error(err?.stack || 'No stack trace available');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Unhandled Rejection:');
    console.error(reason?.message || reason);
    console.error(reason?.stack || 'No stack trace available');
});

// Validate environment on boot
config.validateConfig();

// Initialize local SQLite database strictly for server coalitions
database.initDatabase();

// Prepare commands collection
const commands = [
    targetFinderCommand.data.toJSON(),
    coalitionCommand.data.toJSON(),
];

// Register slash commands with Discord REST API
async function registerCommands() {
    if (!config.discordToken || !config.clientId) {
        console.warn('[Slash Commands] Skipped registration: DISCORD_TOKEN or CLIENT_ID is not configured.');
        return;
    }

    const rest = new REST({ version: '10' }).setToken(config.discordToken);

    try {
        console.log('[Slash Commands] Refreshing application (/) commands...');

        if (config.guildId) {
            // Instant deployment for specified guild (ideal for development/testing)
            await rest.put(
                Routes.applicationGuildCommands(config.clientId, config.guildId),
                { body: commands }
            );
            console.log(`[Slash Commands] Successfully registered ${commands.length} guild commands to guild: ${config.guildId}`);
        } else {
            // Global deployment (available across all servers)
            await rest.put(
                Routes.applicationCommands(config.clientId),
                { body: commands }
            );
            console.log(`[Slash Commands] Successfully registered ${commands.length} global application commands.`);
        }
    } catch (err) {
        console.error('[Slash Commands] Failed to register slash commands:', err.message);
    }
}

// Create Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
    ],
});

// Discord client-level error listeners
client.on('error', (err) => {
    console.error('[Discord Client Error]:', err.message);
});

client.on('shardError', (err) => {
    console.error('[Discord Shard Error]:', err.message);
});

client.on('warn', (warning) => {
    console.warn('[Discord Warning]:', warning);
});

// Event: Client Ready
client.once(Events.ClientReady, async () => {
    console.log(`====================================================`);
    console.log(`☢️  Nuke Target Finder Bot is online as: ${client.user.tag}`);
    console.log(`🛡️  Connected to ${client.guilds.cache.size} server(s)`);
    console.log(`====================================================`);

    // Register slash commands
    await registerCommands();

    // Start background Politics & War data fetcher
    fetcher.startPeriodicFetcher();
});

// Event: Interaction Create
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
        if (commandName === 'target-finder') {
            await targetFinderCommand.execute(interaction);
        } else if (commandName === 'coalition') {
            await coalitionCommand.execute(interaction);
        }
    } catch (err) {
        console.error(`[Interaction Error] Command '${commandName}':`, err);
        const errorMsg = {
            content: '❌ An error occurred while executing this command.',
            ephemeral: true,
        };
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp(errorMsg);
            } else {
                await interaction.reply(errorMsg);
            }
        } catch (_) {}
    }
});

// Graceful Shutdown
function handleShutdown(signal) {
    console.log(`\n[Process] Received ${signal}. Shutting down gracefully...`);
    fetcher.stopPeriodicFetcher();
    database.closeDatabase();
    client.destroy();
    process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// Log in to Discord
if (config.discordToken) {
    client.login(config.discordToken).catch(err => {
        console.error('[Discord Client] Failed to log in:', err.message);
    });
} else {
    console.warn('[Discord Client] DISCORD_TOKEN is missing. Provide it in .env to connect to Discord.');
}
