import { type EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  type FactionMarketRow,
  findFactionMarkets,
} from "../../../db/queries/trading.ts";
import {
  autocompleteFactionFor,
  autocompleteSystem,
  createAutocomplete,
} from "../../autocomplete/index.ts";
import type { BotCommand } from "../../types.ts";
import {
  createPphEmbed,
  formatDistanceLs,
  formatNumber,
  formatPadBadge,
  formatRelativeTimestamp,
  formatStationTypeBadge,
  PPH_COLORS,
} from "../../ui/embeds.ts";
import { sendPaginatedEmbeds } from "../../ui/pagination.ts";

const STATIONS_PER_PAGE = 6;

function formatFactionMarketField(row: FactionMarketRow, index: number): {
  name: string;
  value: string;
} {
  const infBadge =
    typeof row.faction_influence === "number"
      ? ` • **${(row.faction_influence * 100).toFixed(1)}% INF**`
      : "";
  const stateBadge = row.controlling_faction_state
    ? ` • State: **${row.controlling_faction_state}**`
    : "";
  const bmBadge = row.has_blackmarket ? " • 💀 **Black Market**" : "";
  const economyBadge = row.primary_economy ? ` • ${row.primary_economy}` : "";
  const marketTime = row.market_updated_at
    ? `Market ${formatRelativeTimestamp(row.market_updated_at)} (${formatNumber(row.listings_count)} items)`
    : `Meta ${formatRelativeTimestamp(row.updated_at)} (no market snapshot yet)`;

  return {
    name: `#${index + 1} • ${row.station_name} (${row.system_name})`,
    value:
      `${formatPadBadge(row.max_landing_pad)} • ${formatStationTypeBadge({ stationType: row.station_type })} • ${formatDistanceLs(row.distance_to_arrival_ls)}${economyBadge}${bmBadge}\n` +
      `🚩${infBadge}${stateBadge} • 🕒 ${marketTime}`,
  };
}

const factionMarketsCommand: BotCommand = {
  category: "BGS",
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("faction-markets")
    .setDescription(
      "Lists all known stations controlled by a Minor Faction with BGS state, influence %, and market age.",
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
        .setName("system")
        .setDescription("Optional star system filter")
        .setRequired(false)
        .setAutocomplete(true),
    ),

  autocomplete: createAutocomplete({
    faction: autocompleteFactionFor("system"),
    system: autocompleteSystem,
  }),

  async execute(interaction) {
    await interaction.deferReply();

    const factionName =
      interaction.options.getString("faction")?.trim() || "People's Party of Heverty";
    const systemFilter = interaction.options.getString("system")?.trim() || null;

    const stations = await findFactionMarkets(factionName, systemFilter, 30);

    const headerDesc =
      `Controlling Faction: **${factionName}**` +
      (systemFilter ? ` • System: **${systemFilter}**` : "") +
      `\nTotal Controlled Stations Found: \`${stations.length}\``;

    const pages: EmbedBuilder[] = [];
    for (let i = 0; i < stations.length; i += STATIONS_PER_PAGE) {
      const slice = stations.slice(i, i + STATIONS_PER_PAGE);
      const embed = createPphEmbed({
        title: `🚩 Controlled Stations & Markets — ${factionName}`,
        description: headerDesc,
        color: PPH_COLORS.PRIMARY,
      });

      for (let j = 0; j < slice.length; j++) {
        embed.addFields(formatFactionMarketField(slice[j]!, i + j));
      }
      pages.push(embed);
    }

    await sendPaginatedEmbeds(interaction, pages, {
      emptyTitle: `No Controlled Stations Found for ${factionName}`,
      emptyDescription:
        `No stations currently recorded as controlled by **${factionName}**` +
        (systemFilter ? ` in **${systemFilter}**` : "") +
        ` were found in the database yet.`,
    });
  },
};

export default factionMarketsCommand;
