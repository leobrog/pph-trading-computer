import { type EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  type CommodityListingRow,
  findCheapestCommodityBuy,
  type PadFilter,
} from "../../../db/queries/trading.ts";
import {
  autocompleteCommodity,
  autocompleteSystem,
  createAutocomplete,
} from "../../autocomplete/index.ts";
import type { BotCommand } from "../../types.ts";
import {
  createPphEmbed,
  formatCredits,
  formatDistanceLs,
  formatDistanceLy,
  formatNumber,
  formatPadBadge,
  formatRelativeTimestamp,
  formatStationTypeBadge,
  PPH_COLORS,
} from "../../ui/embeds.ts";
import { sendPaginatedEmbeds } from "../../ui/pagination.ts";

const LISTINGS_PER_PAGE = 6;

function formatBuyField(row: CommodityListingRow, index: number): {
  name: string;
  value: string;
} {
  const diffFromMean =
    row.mean_price > 0
      ? Math.round(((row.buy_price - row.mean_price) / row.mean_price) * 100)
      : null;
  const meanBadge =
    diffFromMean !== null
      ? ` (${diffFromMean > 0 ? `+${diffFromMean}%` : `${diffFromMean}%`} vs galactic avg)`
      : "";

  const distBadge = row.distance_ly !== null ? ` • **${formatDistanceLy(row.distance_ly)}**` : "";
  const stationBadge = formatStationTypeBadge({
    stationType: row.station_type,
    isFleetCarrier: row.is_fleet_carrier,
    isColonisationVessel: row.is_colonisation_vessel,
  });
  const factionBadge = row.controlling_faction
    ? ` • 🚩 *${row.controlling_faction}*${row.controlling_faction_state ? ` (${row.controlling_faction_state})` : ""}`
    : "";

  return {
    name: `#${index + 1} • ${formatCredits(row.buy_price)}/t${meanBadge} — ${row.station_name} (${row.system_name})`,
    value:
      `📦 **Stock:** \`${formatNumber(row.stock)}\`${distBadge} • ${formatPadBadge(row.max_landing_pad)} • ${stationBadge} • ${formatDistanceLs(row.distance_to_arrival_ls)}${factionBadge}\n` +
      `🕒 Updated ${formatRelativeTimestamp(row.updated_at)}`,
  };
}

const commodityBuyCommand: BotCommand = {
  category: "Trading",
  cooldownSeconds: 2,
  data: new SlashCommandBuilder()
    .setName("commodity-buy")
    .setDescription(
      "Finds the cheapest recorded buying prices and supply locations for a commodity.",
    )
    .addStringOption((opt) =>
      opt
        .setName("commodity")
        .setDescription("Commodity name or symbol (e.g. Gold, Tritium, Agronomic Treatment)")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("near_system")
        .setDescription("Reference star system for jump distance calculation (e.g. Heverty)")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addNumberOption((opt) =>
      opt
        .setName("max_distance_ly")
        .setDescription("Only search stations within N Light Years of near_system")
        .setMinValue(1)
        .setMaxValue(500)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("min_stock")
        .setDescription("Minimum available supply stock (default: 100)")
        .setMinValue(1)
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName("min_pad")
        .setDescription("Minimum landing pad size required (default: Any)")
        .addChoices(
          { name: "Large (L)", value: "L" },
          { name: "Medium (M or L)", value: "M" },
          { name: "Any", value: "Any" },
        )
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("max_ls")
        .setDescription("Max supercruise distance from star in ls")
        .setMinValue(10)
        .setRequired(false),
    )
    .addBooleanOption((opt) =>
      opt
        .setName("include_carriers")
        .setDescription("Include public Fleet Carriers (default: true)")
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName("sort_by")
        .setDescription("Sort order (default: Cheapest Price First)")
        .addChoices(
          { name: "Cheapest Price First", value: "price" },
          { name: "Closest Distance First (requires near_system)", value: "distance" },
        )
        .setRequired(false),
    ),

  autocomplete: createAutocomplete({
    commodity: autocompleteCommodity,
    near_system: autocompleteSystem,
  }),

  async execute(interaction) {
    await interaction.deferReply();

    const commodityQuery = interaction.options.getString("commodity", true);
    const nearSystem = interaction.options.getString("near_system");
    const maxDistanceLy = interaction.options.getNumber("max_distance_ly");
    const minStock = interaction.options.getInteger("min_stock") ?? 100;
    const minPad = (interaction.options.getString("min_pad") ?? "Any") as PadFilter;
    const maxLs = interaction.options.getInteger("max_ls");
    const includeCarriers = interaction.options.getBoolean("include_carriers") ?? true;
    const sortBy = (interaction.options.getString("sort_by") ?? "price") as
      | "price"
      | "distance";

    const { commodity, referenceSystem, listings } = await findCheapestCommodityBuy({
      commodityQuery,
      nearSystem,
      maxDistanceLy,
      minQuantity: minStock,
      minPad,
      maxLs,
      includeCarriers,
      sortBy,
      limit: 30,
    });

    if (!commodity) {
      const notFoundEmbed = createPphEmbed({
        title: "❓ Commodity Not Found",
        description: `No commodity matching **${commodityQuery}** was found in the catalog.`,
        color: PPH_COLORS.ERROR,
      });
      await interaction.editReply({ embeds: [notFoundEmbed] });
      return;
    }

    const refDesc = referenceSystem
      ? `Near **${referenceSystem.name}**${maxDistanceLy ? ` (≤ ${maxDistanceLy} Ly)` : ""}`
      : "Galactic Search";

    const headerDesc =
      `Category: **${commodity.category}**${commodity.is_rare ? " • ⭐ Rare Good" : ""} • Scope: ${refDesc}\n` +
      `Min Stock: \`${formatNumber(minStock)}\` • Pad: \`${minPad}\` • Carriers: \`${includeCarriers ? "Yes" : "No"}\` • Sort: \`${sortBy === "price" ? "Cheapest First" : "Closest First"}\``;

    const pages: EmbedBuilder[] = [];
    for (let i = 0; i < listings.length; i += LISTINGS_PER_PAGE) {
      const slice = listings.slice(i, i + LISTINGS_PER_PAGE);
      const embed = createPphEmbed({
        title: `🛒 Cheapest Buy Prices — ${commodity.name}`,
        description: headerDesc,
        color: PPH_COLORS.PROFIT,
      });

      for (let j = 0; j < slice.length; j++) {
        embed.addFields(formatBuyField(slice[j]!, i + j));
      }
      pages.push(embed);
    }

    await sendPaginatedEmbeds(interaction, pages, {
      emptyTitle: `No Supply Found for ${commodity.name}`,
      emptyDescription:
        `No stations currently selling **${commodity.name}** matched your filters (${refDesc}).\n` +
        `Try lowering \`min_stock\`, increasing \`max_distance_ly\`, or enabling \`include_carriers: true\`.`,
    });
  },
};

export default commodityBuyCommand;
