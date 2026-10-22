import { type EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  getStationMarketListings,
  type MarketItemRow,
  type MarketListingsFilter,
  type MarketListingsSortBy,
} from "../../../db/queries/trading.ts";
import {
  autocompleteCommodity,
  autocompleteStationFor,
  autocompleteSystem,
  createAutocomplete,
} from "../../autocomplete/index.ts";
import type { BotCommand } from "../../types.ts";
import {
  createPphEmbed,
  formatCredits,
  formatDistanceLs,
  formatNumber,
  formatPadBadge,
  formatRelativeTimestamp,
  formatStationTypeBadge,
  PPH_COLORS,
} from "../../ui/embeds.ts";
import { sendPaginatedEmbeds } from "../../ui/pagination.ts";

const LISTINGS_PER_PAGE = 8;

const FILTER_LABELS: Record<MarketListingsFilter, string> = {
  all: "All Listings (Supply & Demand)",
  supply: "Supply Only (Station Selling)",
  demand: "Demand Only (Station Buying)",
};

const SORT_LABELS: Record<MarketListingsSortBy, string> = {
  category: "Category & Name",
  sell_price: "Highest Sell Price",
  buy_price: "Cheapest Buy Price",
  stock: "Highest Supply Stock",
  demand: "Highest Demand",
  name: "Commodity Name (A–Z)",
};

function formatMeanDiffBadge(price: number, meanPrice: number): string {
  if (price <= 0 || meanPrice <= 0) return "";
  const pct = Math.round(((price - meanPrice) / meanPrice) * 100);
  return ` (${pct > 0 ? `+${pct}%` : `${pct}%`} vs avg)`;
}

function formatMarketListingField(
  item: MarketItemRow,
  index: number,
): {
  name: string;
  value: string;
} {
  const rareTag = item.is_rare ? " • ⭐ Rare" : "";
  const hasSupply = item.buy_price > 0 && item.stock > 0;
  const hasSell = item.sell_price > 0;

  const supplyStr = hasSupply
    ? `**${formatCredits(item.buy_price)}/t**${formatMeanDiffBadge(item.buy_price, item.mean_price)} • Stock: \`${formatNumber(item.stock)}\``
    : item.buy_price > 0
      ? `${formatCredits(item.buy_price)}/t • Stock: \`0\``
      : "*Not sold here*";

  const demandStr = hasSell
    ? `**${formatCredits(item.sell_price)}/t**${formatMeanDiffBadge(item.sell_price, item.mean_price)} • Demand: \`${formatNumber(item.demand)}\``
    : "*Not bought here*";

  return {
    name: `#${index + 1} • ${item.commodity_name} (${item.commodity_category}${rareTag})`,
    value: `📤 **Buy (Supply):** ${supplyStr}\n📥 **Sell (Demand):** ${demandStr}`,
  };
}

const marketListingsCommand: BotCommand = {
  category: "Trading",
  cooldownSeconds: 2,
  data: new SlashCommandBuilder()
    .setName("market-listings")
    .setDescription(
      "Displays all recorded commodity buy/sell prices, supply stock, and demand for a specific market.",
    )
    .addStringOption((opt) =>
      opt
        .setName("station")
        .setDescription(
          "Station, outpost, settlement, or Fleet Carrier name (e.g. Woodroffe Gateway)",
        )
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("system")
        .setDescription(
          "Optional star system name to disambiguate or filter stations (e.g. Heverty)",
        )
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("filter")
        .setDescription("Filter listings by Supply (buy here) or Demand (sell here)")
        .addChoices(
          { name: "All Listings (Supply & Demand)", value: "all" },
          { name: "Supply Only — Station Selling (Buy here)", value: "supply" },
          { name: "Demand Only — Station Buying (Sell here)", value: "demand" },
        )
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName("commodity")
        .setDescription(
          "Filter by a specific commodity name, symbol, or category (e.g. Gold, Metals)",
        )
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("min_stock")
        .setDescription("Minimum available supply stock units")
        .setMinValue(1)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("min_demand")
        .setDescription("Minimum station demand units")
        .setMinValue(0)
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName("sort_by")
        .setDescription("Sort order for commodity listings (default: Category & Name)")
        .addChoices(
          { name: "Category & Name (Default)", value: "category" },
          { name: "Highest Sell Price First (Demand)", value: "sell_price" },
          { name: "Cheapest Buy Price First (Supply)", value: "buy_price" },
          { name: "Highest Supply Stock First", value: "stock" },
          { name: "Highest Demand First", value: "demand" },
          { name: "Commodity Name (A–Z)", value: "name" },
        )
        .setRequired(false),
    ),

  autocomplete: createAutocomplete({
    station: autocompleteStationFor("system"),
    system: autocompleteSystem,
    commodity: autocompleteCommodity,
  }),

  async execute(interaction) {
    await interaction.deferReply();

    const stationQuery = interaction.options.getString("station", true);
    const systemFilter = interaction.options.getString("system");
    const filter = (interaction.options.getString("filter") ??
      "all") as MarketListingsFilter;
    const commodityQuery = interaction.options.getString("commodity");
    const minStock = interaction.options.getInteger("min_stock") ?? 0;
    const minDemand = interaction.options.getInteger("min_demand") ?? 0;
    const sortBy = (interaction.options.getString("sort_by") ??
      "category") as MarketListingsSortBy;

    const { station, listings } = await getStationMarketListings({
      station: stationQuery,
      system: systemFilter,
      filter,
      commodityQuery,
      minStock,
      minDemand,
      sortBy,
      limit: 160,
    });

    if (!station) {
      const notFoundEmbed = createPphEmbed({
        title: "❓ Market Not Found",
        description:
          `Could not find station or market matching **${stationQuery}**` +
          (systemFilter ? ` in **${systemFilter}**` : "") +
          ` in the database or Spansh.`,
        color: PPH_COLORS.ERROR,
      });
      await interaction.editReply({ embeds: [notFoundEmbed] });
      return;
    }

    const stationBadge = formatStationTypeBadge({
      stationType: station.station_type,
      isFleetCarrier: station.is_fleet_carrier,
      isColonisationVessel: station.is_colonisation_vessel,
    });

    const ownerText = station.controlling_faction
      ? `**${station.controlling_faction}**${station.controlling_faction_state ? ` (\`${station.controlling_faction_state}\`)` : ""}`
      : "*Uncontrolled / Private*";

    const economyText = station.primary_economy ?? "Unknown";
    const bmTag = station.has_blackmarket ? " • 💀 **Black Market**" : "";
    const marketAge = station.market_updated_at
      ? formatRelativeTimestamp(station.market_updated_at)
      : "No snapshot yet";

    const filterParts: string[] = [
      `Filter: \`${FILTER_LABELS[filter]}\``,
      `Sort: \`${SORT_LABELS[sortBy]}\``,
      `Showing: \`${formatNumber(listings.length)} / ${formatNumber(station.total_listings_count)}\``,
    ];
    if (commodityQuery) filterParts.push(`Query: \`${commodityQuery}\``);
    if (minStock > 0) filterParts.push(`Min Stock: \`${formatNumber(minStock)}\``);
    if (minDemand > 0) filterParts.push(`Min Demand: \`${formatNumber(minDemand)}\``);

    const headerDesc =
      `🌌 **System:** **${station.system_name}** • ${formatPadBadge(station.max_landing_pad)} • ${stationBadge} • ${formatDistanceLs(station.distance_to_arrival_ls)}\n` +
      `🚩 **Owner:** ${ownerText} • 🏭 **Economy:** \`${economyText}\`${bmTag}\n` +
      `📦 **Supply Items:** \`${formatNumber(station.supply_count)}\` • 📥 **Demand Items:** \`${formatNumber(station.demand_count)}\` • 🕒 **Updated:** ${marketAge}\n` +
      filterParts.join(" • ");

    const pages: EmbedBuilder[] = [];
    for (let i = 0; i < listings.length; i += LISTINGS_PER_PAGE) {
      const slice = listings.slice(i, i + LISTINGS_PER_PAGE);
      const embed = createPphEmbed({
        title: `🏪 Market Listings — ${station.station_name} (${station.system_name})`,
        description: headerDesc,
        color: PPH_COLORS.INFO,
      });

      for (let j = 0; j < slice.length; j++) {
        embed.addFields(formatMarketListingField(slice[j]!, i + j));
      }
      pages.push(embed);
    }

    await sendPaginatedEmbeds(interaction, pages, {
      emptyTitle: `No Matching Listings at ${station.station_name} (${station.system_name})`,
      emptyDescription:
        station.total_listings_count === 0
          ? `Station **${station.station_name}** (${station.system_name}) is recorded in the database, but no live commodity market snapshot has been received for it yet.`
          : `No commodities at **${station.station_name}** (${station.system_name}) matched your current filters (\`${FILTER_LABELS[filter]}\`${commodityQuery ? `, \`${commodityQuery}\`` : ""}).`,
    });
  },
};

export default marketListingsCommand;
