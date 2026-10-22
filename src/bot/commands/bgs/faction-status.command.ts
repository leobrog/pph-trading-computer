import { type EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  type FactionStatusSortBy,
  type FactionSystemPresenceRow,
  getFactionStatusReport,
} from "../../../db/queries/bgs.ts";
import {
  autocompleteFactionFor,
  autocompleteSystem,
  createAutocomplete,
} from "../../autocomplete/index.ts";
import type { BotCommand } from "../../types.ts";
import {
  createPphEmbed,
  formatDistanceLy,
  formatInfluenceBar,
  formatNumber,
  formatRelativeTimestamp,
  PPH_COLORS,
} from "../../ui/embeds.ts";
import { sendPaginatedEmbeds } from "../../ui/pagination.ts";

const SYSTEMS_PER_PAGE = 6;

function formatPresenceField(
  row: FactionSystemPresenceRow,
  index: number,
): { name: string; value: string } {
  const controlBadge = row.is_controlling_system ? "👑 Controlling" : "🚩 Present";
  const distTag =
    row.distance_ly !== null ? ` • ${formatDistanceLy(row.distance_ly)}` : "";

  const primaryState = row.faction_state || "None";
  const extraActive = row.active_states.filter(
    (s) => s.toLowerCase() !== primaryState.toLowerCase(),
  );

  let stateLine = `📊 **State:** \`${primaryState}\``;
  if (extraActive.length > 0) {
    stateLine += ` • **Active:** ${extraActive.map((s) => `\`${s}\``).join(", ")}`;
  }
  if (row.pending_states.length > 0) {
    stateLine += ` • ⏳ **Pending:** ${row.pending_states.map((s) => `\`${s}\``).join(", ")}`;
  }
  if (row.recovering_states.length > 0) {
    stateLine += ` • 🩹 **Recovering:** ${row.recovering_states.map((s) => `\`${s}\``).join(", ")}`;
  }

  let marginNote = "";
  if (
    row.influence !== null &&
    row.rival_faction_name &&
    row.rival_influence !== null
  ) {
    const diffPct = (row.influence - row.rival_influence) * 100;
    const sign = diffPct >= 0 ? `+${diffPct.toFixed(1)}%` : `${diffPct.toFixed(1)}%`;
    marginNote = ` (${sign} vs *${row.rival_faction_name}*)`;
  }

  const happyNote = row.happiness ? ` • 😊 ${row.happiness}` : "";
  const sysOwnerNote = !row.is_controlling_system && row.system_controlling_faction
    ? ` • Ruler: *${row.system_controlling_faction}*`
    : "";

  return {
    name: `#${index + 1} • ${row.system_name} — ${controlBadge}${distTag}`,
    value:
      `${formatInfluenceBar(row.influence)}${marginNote}${happyNote}\n` +
      `${stateLine}\n` +
      `🎡 **Stations:** \`${row.controlled_stations_count}/${row.total_stations_count}\` • 👥 **Pop:** \`${formatNumber(row.population)}\`${sysOwnerNote} • 🕒 ${formatRelativeTimestamp(row.updated_at)}`,
  };
}

const factionStatusCommand: BotCommand = {
  category: "BGS",
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("faction-status")
    .setDescription(
      "Displays a Minor Faction's BGS influence, states, and controlled assets across systems.",
    )
    .addStringOption((opt) =>
      opt
        .setName("faction")
        .setDescription("Minor Faction name (default: People's Party of Heverty)")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("near_system")
        .setDescription("Reference star system for distance calculation (default: Heverty)")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addNumberOption((opt) =>
      opt
        .setName("max_distance_ly")
        .setDescription("Only show systems within N Light Years of near_system")
        .setMinValue(1)
        .setMaxValue(500)
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName("state_filter")
        .setDescription(
          "Filter by active/pending/recovering BGS state (e.g. Boom, War, Election, Expansion)",
        )
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName("sort_by")
        .setDescription("Sort order (default: Highest Influence First)")
        .addChoices(
          { name: "Highest Influence % First", value: "influence" },
          { name: "Closest Distance First", value: "distance" },
          { name: "Largest Population First", value: "population" },
          { name: "System Name (A-Z)", value: "name" },
        )
        .setRequired(false),
    ),

  autocomplete: createAutocomplete({
    faction: autocompleteFactionFor("near_system"),
    near_system: autocompleteSystem,
  }),

  async execute(interaction) {
    await interaction.deferReply();

    const factionQuery =
      interaction.options.getString("faction")?.trim() || "People's Party of Heverty";
    const nearSystem = interaction.options.getString("near_system")?.trim() || "Heverty";
    const maxDistanceLy = interaction.options.getNumber("max_distance_ly");
    const stateFilter = interaction.options.getString("state_filter")?.trim() || null;
    const sortBy = (interaction.options.getString("sort_by") ??
      "influence") as FactionStatusSortBy;

    const report = await getFactionStatusReport({
      factionName: factionQuery,
      nearSystem,
      maxDistanceLy,
      stateFilter,
      sortBy,
      limit: 36,
    });

    if (!report.faction) {
      const notFoundEmbed = createPphEmbed({
        title: "❓ Minor Faction Not Found",
        description: `Could not find minor faction **${factionQuery}** in the database yet.`,
        color: PPH_COLORS.ERROR,
      });
      await interaction.editReply({ embeds: [notFoundEmbed] });
      return;
    }

    const { faction, referenceSystem, presences } = report;

    const controlledSystemsCount = presences.filter((p) => p.is_controlling_system).length;
    const totalControlledStations = presences.reduce(
      (sum, p) => sum + p.controlled_stations_count,
      0,
    );
    const validInf = presences.filter((p) => p.influence !== null);
    const avgInfluencePct =
      validInf.length > 0
        ? (
            (validInf.reduce((sum, p) => sum + (p.influence ?? 0), 0) / validInf.length) *
            100
          ).toFixed(1)
        : "0.0";

    const scopeStr = referenceSystem
      ? `Ref: **${referenceSystem.name}**${maxDistanceLy ? ` (≤ ${maxDistanceLy} Ly)` : ""}`
      : "Galactic";

    const headerDesc =
      `🏛️ **Government:** \`${faction.government ?? "Unknown"}\` • **Allegiance:** \`${faction.allegiance ?? "Unknown"}\` • ${scopeStr}\n` +
      `🌌 **Systems Present:** \`${presences.length}\` • 👑 **Systems Controlled:** \`${controlledSystemsCount}\` • 🎡 **Stations Controlled:** \`${totalControlledStations}\` • 📈 **Avg INF:** \`${avgInfluencePct}%\`` +
      (stateFilter ? `\n🔍 **State Filter:** \`${stateFilter}\`` : "");

    const pages: EmbedBuilder[] = [];
    for (let i = 0; i < presences.length; i += SYSTEMS_PER_PAGE) {
      const slice = presences.slice(i, i + SYSTEMS_PER_PAGE);
      const embed = createPphEmbed({
        title: `🚩 Faction BGS Overview — ${faction.name}`,
        description: headerDesc,
        color: PPH_COLORS.PRIMARY,
      });

      for (let j = 0; j < slice.length; j++) {
        embed.addFields(formatPresenceField(slice[j]!, i + j));
      }
      pages.push(embed);
    }

    await sendPaginatedEmbeds(interaction, pages, {
      emptyTitle: `No Matching Systems Found for ${faction.name}`,
      emptyDescription:
        `No system presences found for **${faction.name}**` +
        (stateFilter ? ` with state matching \`${stateFilter}\`` : "") +
        (maxDistanceLy && referenceSystem
          ? ` within **${maxDistanceLy} Ly** of **${referenceSystem.name}**`
          : "") +
        ".",
    });
  },
};

export default factionStatusCommand;
