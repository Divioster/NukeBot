const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
} = require('discord.js');
const database = require('../database');
const config = require('../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('coalition')
        .setDescription('Manage local alliance coalitions for this server')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub
                .setName('add')
                .setDescription('Add a new coalition of alliance IDs for this server')
                .addStringOption(opt =>
                    opt
                        .setName('name')
                        .setDescription('Coalition identifier name (e.g. enemies, sphere)')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt
                        .setName('alliance_ids')
                        .setDescription('Comma-separated alliance IDs (e.g. 123, 456, 789)')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('delete')
                .setDescription('Remove a coalition from this server')
                .addStringOption(opt =>
                    opt
                        .setName('name')
                        .setDescription('Coalition name to delete')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('update')
                .setDescription('Update the alliance IDs of an existing coalition')
                .addStringOption(opt =>
                    opt
                        .setName('name')
                        .setDescription('Coalition name to update')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt
                        .setName('alliance_ids')
                        .setDescription('New comma-separated alliance IDs (e.g. 123, 456, 789)')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('list')
                .setDescription('List all saved coalitions for this server')
        ),

    async execute(interaction) {
        if (!interaction.guildId) {
            return interaction.reply({
                content: 'This command can only be used inside a Discord server.',
                ephemeral: true,
            });
        }

        // Verify administrator permission
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '❌ You must have Administrator permissions to manage server coalitions.',
                ephemeral: true,
            });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        try {
            if (subcommand === 'add') {
                const name = interaction.options.getString('name').trim().toLowerCase();
                const rawIds = interaction.options.getString('alliance_ids');
                const cleanIds = database.normalizeAllianceIds(rawIds);

                if (!cleanIds) {
                    return interaction.reply({
                        content: '❌ Invalid alliance IDs provided. Please enter numeric alliance IDs separated by commas (e.g. `123, 456`).',
                        ephemeral: true,
                    });
                }

                database.saveCoalition(guildId, name, cleanIds);
                const count = cleanIds.split(',').length;

                const embed = new EmbedBuilder()
                    .setTitle('🛡️ Coalition Saved')
                    .setColor(config.embedColor)
                    .setDescription(`Successfully created coalition **${name}** for this server.`)
                    .addFields(
                        { name: 'Coalition Name', value: `\`${name}\``, inline: true },
                        { name: 'Alliance Count', value: `${count}`, inline: true },
                        { name: 'Alliance IDs', value: `\`${cleanIds}\``, inline: false }
                    )
                    .setFooter({ text: 'Use this name in /target-finder nuke coalition_or_alliance' });

                return interaction.reply({ embeds: [embed] });
            }

            if (subcommand === 'update') {
                const name = interaction.options.getString('name').trim().toLowerCase();
                const existing = database.getCoalition(guildId, name);
                if (!existing) {
                    return interaction.reply({
                        content: `❌ Coalition **${name}** does not exist for this server. Use \`/coalition add\` to create it.`,
                        ephemeral: true,
                    });
                }

                const rawIds = interaction.options.getString('alliance_ids');
                const cleanIds = database.normalizeAllianceIds(rawIds);
                if (!cleanIds) {
                    return interaction.reply({
                        content: '❌ Invalid alliance IDs provided. Please enter numeric alliance IDs separated by commas.',
                        ephemeral: true,
                    });
                }

                database.saveCoalition(guildId, name, cleanIds);
                const count = cleanIds.split(',').length;

                const embed = new EmbedBuilder()
                    .setTitle('✏️ Coalition Updated')
                    .setColor(config.embedColor)
                    .setDescription(`Coalition **${name}** has been updated successfully.`)
                    .addFields(
                        { name: 'Coalition Name', value: `\`${name}\``, inline: true },
                        { name: 'Alliance Count', value: `${count}`, inline: true },
                        { name: 'New Alliance IDs', value: `\`${cleanIds}\``, inline: false }
                    );

                return interaction.reply({ embeds: [embed] });
            }

            if (subcommand === 'delete') {
                const name = interaction.options.getString('name').trim().toLowerCase();
                const deleted = database.deleteCoalition(guildId, name);

                if (!deleted) {
                    return interaction.reply({
                        content: `❌ Coalition **${name}** was not found for this server.`,
                        ephemeral: true,
                    });
                }

                const embed = new EmbedBuilder()
                    .setTitle('🗑️ Coalition Deleted')
                    .setColor(config.embedColor)
                    .setDescription(`Coalition **${name}** has been removed from this server.`);

                return interaction.reply({ embeds: [embed] });
            }

            if (subcommand === 'list') {
                const coalitions = database.listCoalitions(guildId);

                if (coalitions.length === 0) {
                    const embed = new EmbedBuilder()
                        .setTitle('🛡️ Server Coalitions')
                        .setColor(config.embedColor)
                        .setDescription('No coalitions registered for this server yet.\nUse `/coalition add name:<name> alliance_ids:<ids>` to create one.');

                    return interaction.reply({ embeds: [embed] });
                }

                const embed = new EmbedBuilder()
                    .setTitle(`🛡️ Server Coalitions (${coalitions.length})`)
                    .setColor(config.embedColor)
                    .setDescription('Configured coalitions available for target finding on this server:');

                for (const c of coalitions) {
                    const idCount = c.alliance_ids.split(',').length;
                    embed.addFields({
                        name: `• ${c.name} (${idCount} alliances)`,
                        value: `\`${c.alliance_ids}\``,
                        inline: false,
                    });
                }

                return interaction.reply({ embeds: [embed] });
            }
        } catch (err) {
            console.error('[Coalition Command Error]:', err);
            return interaction.reply({
                content: `❌ An error occurred: ${err.message}`,
                ephemeral: true,
            });
        }
    },
};
