import { SlashCommandBuilder } from "discord.js";
import { seedRegionAroundSystem } from "../../../../scripts/seed-region.ts";
import { autocompleteSystem, createAutocomplete } from "../../autocomplete/index.ts";
import type { BotCommand } from "../../types.ts";
import { createPphEmbed, formatNumber, PPH_COLORS } from "../../ui/embeds.ts";

const seedRegionCommand: BotCommand = {
  category: "Utility",
  cooldownSeconds: 15,
  data: new SlashCommandBuilder()
    .setName("seed-region")
    .setDescription(
      "Bootstraps populated systems, stations, BGS factions, and recent markets within N Ly of a system.",
    )
    .addStringOption((opt) =>
      opt
        .setName("system")
        .setDescription("Center star system (default: Heverty)")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addNumberOption((opt) =>
      opt
        .setName("radius_ly")
        .setDescription("Radius in Light Years to seed around system (default: 40, max: 100)")
        .setMinValue(5)
        .setMaxValue(100)
        .setRequired(false),
    ),

  autocomplete: createAutocomplete({
    system: autocompleteSystem,
  }),

  async execute(interaction) {
    await interaction.deferReply();

    const centerSystem = interaction.options.getString("system")?.trim() || "Heverty";
    const radiusLy = interaction.options.getNumber("radius_ly") ?? 40;

    const result = await seedRegionAroundSystem({
      centerSystem,
      radiusLy,
      includeMarkets: true,
    });

    const embed = createPphEmbed({
      title: `🌌 Regional Galaxy Seed Complete — ${result.centerSystem}`,
      description:
        `Imported populated systems, stations, minor faction BGS presences, and active commodity markets within **${result.radiusLy} Ly** of **${result.centerSystem}** in \`${(result.durationMs / 1000).toFixed(1)}s\`.`,
      color: PPH_COLORS.INFO,
    }).addFields(
      {
        name: "🌟 Populated Systems",
        value: `\`${formatNumber(result.systemsUpserted)}\``,
        inline: true,
      },
      {
        name: "🎡 Permanent Stations",
        value: `\`${formatNumber(result.stationsUpserted)}\``,
        inline: true,
      },
      {
        name: "🚩 BGS Faction Presences",
        value: `\`${formatNumber(result.factionsUpserted)}\``,
        inline: true,
      },
      {
        name: "🛒 Active Markets Seeded",
        value: `\`${formatNumber(result.marketsUpserted)}\` stations (\`${formatNumber(result.listingsUpserted)}\` listings)`,
        inline: false,
      },
    );

    await interaction.editReply({ embeds: [embed] });
  },
};

export default seedRegionCommand;
