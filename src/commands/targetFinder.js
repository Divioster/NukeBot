const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
} = require('discord.js');
const database = require('../database');
const nationsCache = require('../nationsCache');
const config = require('../config');
const {
    calculateNukeDamage,
    calculateDamageValue,
    calculateInfraCost,
    addCommas,
    formatCash,
} = require('../logic/weaponDamageCalc');

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

/**
 * Evaluates and scores a nation's top N cities for nuke strikes.
 */
function evaluateNationNukeTargets(nation, topN = 3, guidingSatellite = false, sortBy = 'damage_value') {
    const cities = Array.isArray(nation.cities) ? nation.cities : [];
    if (cities.length === 0) return null;

    const evaluatedCities = cities.map(c => {
        const infra = Number(c.infra !== undefined ? c.infra : (c.infrastructure || 0));
        const land = Number(c.land !== undefined ? c.land : infra);
        const infraWorth = calculateInfraCost(infra);

        const res = calculateNukeDamage({
            infra,
            land,
            guidingSatellite,
        });

        const nukeDamage = res.expectedDamage;
        const nukeDamageValue = calculateDamageValue(infra, nukeDamage);

        return {
            id: c.id,
            name: c.name || `City #${c.id}`,
            infra,
            land,
            infraWorth,
            nukeDamage,
            nukeDamageValue,
        };
    });

    if (sortBy === 'infra_destroyed') {
        evaluatedCities.sort((a, b) => b.nukeDamage - a.nukeDamage);
    } else if (sortBy === 'infra_worth') {
        evaluatedCities.sort((a, b) => b.infraWorth - a.infraWorth);
    } else {
        // default: damage_value (monetary rebuild cost destroyed)
        evaluatedCities.sort((a, b) => b.nukeDamageValue - a.nukeDamageValue);
    }

    const n = Math.min(topN, evaluatedCities.length);
    const topCities = evaluatedCities.slice(0, n);

    let totalDamageValue = 0;
    let totalNukeDamage = 0;
    let totalInfraWorth = 0;

    for (const c of topCities) {
        totalDamageValue += c.nukeDamageValue;
        totalNukeDamage += c.nukeDamage;
        totalInfraWorth += c.infraWorth;
    }

    return {
        ...nation,
        evaluatedTopCities: topCities,
        topNCitiesCount: n,
        totalDamageValue,
        totalNukeDamage,
        totalInfraWorth,
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('target-finder')
        .setDescription('Find and evaluate high-infrastructure targets in Politics & War')
        .addSubcommand(sub =>
            sub
                .setName('nuke')
                .setDescription('Evaluate and rank high-infrastructure nuclear strike targets')
                .addIntegerOption(opt =>
                    opt
                        .setName('cities')
                        .setDescription('Top N cities to evaluate per nation (1-10, default: 3)')
                        .setMinValue(1)
                        .setMaxValue(10)
                )
                .addStringOption(opt =>
                    opt
                        .setName('sort_by')
                        .setDescription('Ranking criterion (default: Rebuild Cost Destroyed)')
                        .addChoices(
                            { name: 'Rebuild Value Destroyed ($)', value: 'damage_value' },
                            { name: 'Raw Infra Destroyed', value: 'infra_destroyed' },
                            { name: 'Total Infra Value', value: 'infra_worth' }
                        )
                )
                .addStringOption(opt =>
                    opt
                        .setName('coalition_or_alliance')
                        .setDescription('Saved coalition name OR comma-separated alliance IDs (e.g. 123, 456)')
                )
                .addIntegerOption(opt =>
                    opt
                        .setName('manual_score')
                        .setDescription('Attacker score to automatically compute 0.75x–2.5x war range')
                )
                .addIntegerOption(opt =>
                    opt
                        .setName('min_score')
                        .setDescription('Minimum target nation score')
                )
                .addIntegerOption(opt =>
                    opt
                        .setName('max_score')
                        .setDescription('Maximum target nation score')
                )
                .addBooleanOption(opt =>
                    opt
                        .setName('has_open_defensives')
                        .setDescription('Only show nations with open defensive war slots (< 3 wars, default: true)')
                )
                .addBooleanOption(opt =>
                    opt
                        .setName('include_beige')
                        .setDescription('Include nations currently on beige (default: false)')
                )
                .addBooleanOption(opt =>
                    opt
                        .setName('include_applicants')
                        .setDescription('Include alliance applicants (default: false)')
                )
                .addBooleanOption(opt =>
                    opt
                        .setName('guiding_satellite')
                        .setDescription('Attacker has Guiding Satellite (+20% damage, default: false)')
                )
        ),

    async execute(interaction) {
        try {
            await interaction.deferReply();

            const topN = interaction.options.getInteger('cities') || 3;
            const sortBy = interaction.options.getString('sort_by') || 'damage_value';
            const coalitionOrAlliance = interaction.options.getString('coalition_or_alliance');
            const hasOpenDefensives = interaction.options.getBoolean('has_open_defensives') !== false;
            const includeBeige = interaction.options.getBoolean('include_beige') || false;
            const includeApplicants = interaction.options.getBoolean('include_applicants') || false;
            const guidingSatellite = interaction.options.getBoolean('guiding_satellite') || false;

            let minScore = interaction.options.getInteger('min_score');
            let maxScore = interaction.options.getInteger('max_score');
            const manualScore = interaction.options.getInteger('manual_score');

            // Automatic score range if attacker score provided
            if (manualScore && !minScore && !maxScore) {
                minScore = Math.floor(manualScore * 0.75);
                maxScore = Math.floor(manualScore * 2.5);
            }

            // Check if JSON cache has nations
            const nationCount = nationsCache.getNationCount();
            if (nationCount === 0) {
                const emptyEmbed = new EmbedBuilder()
                    .setTitle('☢️ Nuke Target Finder — Cache Empty')
                    .setColor(config.embedColor)
                    .setDescription('⚠️ The nation JSON cache is empty or initial synchronization is currently in progress.\nPlease allow the background fetcher a few moments to pull nation data from the Politics & War API.')
                    .setFooter({ text: 'Periodic fetcher runs automatically.' });

                return interaction.editReply({ embeds: [emptyEmbed] });
            }

            // Resolve target alliance IDs from local SQLite coalition or direct ID input
            let targetAlliances = null;
            if (coalitionOrAlliance) {
                const queryStr = coalitionOrAlliance.trim().toLowerCase();

                // 1. Check local server coalitions stored in SQLite
                if (interaction.guildId) {
                    const saved = database.getCoalition(interaction.guildId, queryStr);
                    if (saved && saved.alliance_ids) {
                        targetAlliances = saved.alliance_ids
                            .split(',')
                            .map(id => id.trim())
                            .filter(Boolean);
                    }
                }

                // 2. Direct comma-separated alliance IDs
                if (!targetAlliances) {
                    const normalized = database.normalizeAllianceIds(coalitionOrAlliance);
                    if (normalized) {
                        targetAlliances = normalized
                            .split(',')
                            .map(id => id.trim())
                            .filter(Boolean);
                    }
                }
            }

            // Query filtered candidate nations from in-memory JSON cache
            const candidateRows = nationsCache.getNations({
                min_score: minScore,
                max_score: maxScore,
                has_open_defensives: hasOpenDefensives,
                include_beige: includeBeige,
                include_vacation: false,
                include_applicants: includeApplicants,
                alliance_ids: targetAlliances,
            });

            const scoredTargets = [];
            for (const n of candidateRows) {
                const scored = evaluateNationNukeTargets(n, topN, guidingSatellite, sortBy);
                if (scored && scored.totalDamageValue > 0) {
                    scoredTargets.push(scored);
                }
            }

            if (scoredTargets.length === 0) {
                const notFoundEmbed = new EmbedBuilder()
                    .setTitle('☢️ Nuke Target Finder — No Targets Found')
                    .setColor(config.embedColor)
                    .setDescription('No nuke targets were found matching your criteria.')
                    .addFields(
                        { name: 'Cities Evaluated', value: `${topN}`, inline: true },
                        { name: 'Score Range', value: `${minScore && maxScore ? `${addCommas(minScore)} - ${addCommas(maxScore)}` : 'All Scores'}`, inline: true },
                        { name: 'Alliances / Coalition', value: `${targetAlliances ? targetAlliances.join(', ') : 'All Alliances'}`, inline: true }
                    );

                return interaction.editReply({ embeds: [notFoundEmbed] });
            }

            // Sort candidates
            if (sortBy === 'infra_destroyed') {
                scoredTargets.sort((a, b) => b.totalNukeDamage - a.totalNukeDamage);
            } else if (sortBy === 'infra_worth') {
                scoredTargets.sort((a, b) => b.totalInfraWorth - a.totalInfraWorth);
            } else {
                scoredTargets.sort((a, b) => b.totalDamageValue - a.totalDamageValue);
            }

            await sendPaginatedNukeTargets(interaction, scoredTargets, {
                topN,
                sortBy,
                guidingSatellite,
                scoreRange: minScore && maxScore ? `${addCommas(minScore)} - ${addCommas(maxScore)}` : 'All Scores',
            });

        } catch (err) {
            console.error('[TargetFinder Error]:', err);
            const errorEmbed = new EmbedBuilder()
                .setTitle('☢️ Nuke Target Finder Error')
                .setDescription(err.message || 'An unexpected error occurred.')
                .setColor(config.embedColor);

            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed] });
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }
    },
};

/**
 * Sends interactive paginated embeds with exact layout and radioactive green color.
 */
async function sendPaginatedNukeTargets(interaction, targets, meta) {
    const pageSize = 3;
    const pages = chunkArray(targets, pageSize);
    let pageIndex = 0;

    const buildEmbedForPage = (idx) => {
        const slice = pages[idx];
        const startRank = idx * pageSize + 1;
        const endRank = Math.min((idx + 1) * pageSize, targets.length);

        const sortLabel = meta.sortBy === 'infra_destroyed'
            ? 'Raw Infra Destroyed'
            : meta.sortBy === 'infra_worth'
                ? 'Total Infra Value'
                : 'Rebuild Value Destroyed ($)';

        const embed = new EmbedBuilder()
            .setTitle(`☢️ Nuke Target Finder — Ranked ${startRank}–${endRank} of ${targets.length}`)
            .setColor(config.embedColor)
            .setDescription(
                `Evaluating **Top ${meta.topN} Cities** • Sorted by **${sortLabel}**\n` +
                `War Range: \`${meta.scoreRange}\`${meta.guidingSatellite ? ' • **Guiding Satellite (+20%)**' : ''}`
            );

        for (let i = 0; i < slice.length; i++) {
            const n = slice[i];
            const rank = startRank + i;
            const allianceName = n.alliance_name || 'No Alliance';

            let citiesDetail = '';
            for (const c of n.evaluatedTopCities) {
                const cityLabel = c.name && !c.name.startsWith('City #') ? c.name : `City #${c.id}`;
                citiesDetail += `• [${cityLabel}](https://politicsandwar.com/city/id=${c.id}) (${addCommas(c.infra)} infra) ➔ **−${addCommas(c.nukeDamage)}** (${formatCash(c.nukeDamageValue)})\n`;
            }

            const header = `#${rank} • ${n.nation_name || `Nation #${n.id}`} — ${allianceName}`;
            const nationLink = `[Open Nation #${n.id}](https://politicsandwar.com/nation/id=${n.id})`;

            const statsBlock =
                `\`\`\`\n` +
                `🎯 Score: ${addCommas(n.score)}  |  🏙️ ${n.num_cities || (n.cities ? n.cities.length : 0)} cities  |  🛡️ ${n.defensive_wars_count || 0}/3 def wars\n\n` +
                `💥 Top ${n.topNCitiesCount} Rebuild Loss: ${formatCash(n.totalDamageValue)} (-${addCommas(n.totalNukeDamage)} infra)\n\n` +
                `⚔️ Air: ${addCommas(n.aircraft || 0)}  |  Ships: ${addCommas(n.ships || 0)}  |  Nukes: ${n.nukes || 0}  |  Spies: ${n.spies || 0}\n` +
                `\`\`\``;

            embed.addFields({
                name: header,
                value: `${nationLink}\n${statsBlock}\n${citiesDetail.trimEnd()}`,
                inline: false,
            });
        }

        embed.setFooter({
            text: `Page ${idx + 1} of ${pages.length} • Total ${addCommas(targets.length)} targets`,
        });

        return embed;
    };

    const firstBtn = new ButtonBuilder().setCustomId('first').setLabel('⏪').setStyle(ButtonStyle.Secondary).setDisabled(true);
    const prevBtn = new ButtonBuilder().setCustomId('prev').setLabel('◀️').setStyle(ButtonStyle.Secondary).setDisabled(true);
    const nextBtn = new ButtonBuilder().setCustomId('next').setLabel('▶️').setStyle(ButtonStyle.Secondary).setDisabled(pages.length <= 1);
    const lastBtn = new ButtonBuilder().setCustomId('last').setLabel('⏩').setStyle(ButtonStyle.Secondary).setDisabled(pages.length <= 1);

    const row = new ActionRowBuilder().addComponents(firstBtn, prevBtn, nextBtn, lastBtn);

    const message = await interaction.editReply({
        embeds: [buildEmbedForPage(pageIndex)],
        components: [row],
    });

    if (pages.length <= 1) return;

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 180_000,
    });

    collector.on('collect', async (i) => {
        if (i.user.id !== interaction.user.id) {
            return i.reply({ content: 'These pagination controls are only for the user who ran the command.', ephemeral: true });
        }

        if (i.customId === 'prev') {
            if (pageIndex > 0) pageIndex--;
        } else if (i.customId === 'next') {
            if (pageIndex < pages.length - 1) pageIndex++;
        } else if (i.customId === 'first') {
            pageIndex = 0;
        } else if (i.customId === 'last') {
            pageIndex = pages.length - 1;
        }

        prevBtn.setDisabled(pageIndex === 0);
        firstBtn.setDisabled(pageIndex === 0);
        lastBtn.setDisabled(pageIndex === pages.length - 1);
        nextBtn.setDisabled(pageIndex === pages.length - 1);

        await i.update({
            embeds: [buildEmbedForPage(pageIndex)],
            components: [new ActionRowBuilder().addComponents(firstBtn, prevBtn, nextBtn, lastBtn)],
        });
    });

    collector.on('end', async () => {
        prevBtn.setDisabled(true);
        nextBtn.setDisabled(true);
        firstBtn.setDisabled(true);
        lastBtn.setDisabled(true);
        try {
            await interaction.editReply({
                components: [new ActionRowBuilder().addComponents(firstBtn, prevBtn, nextBtn, lastBtn)],
            });
        } catch (_) {}
    });
}
