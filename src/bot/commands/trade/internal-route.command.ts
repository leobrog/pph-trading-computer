import { type EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  findInternalTradeRoutes,
  type PadFilter,
  type TradeRouteRow,
} from "../../../db/queries/trading.ts";
import {
  autocompleteCommodity,
  autocompleteFactionFor,
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

const ROUTES_PER_PAGE = 5;

function formatInternalRouteField(
  route: TradeRouteRow,
  index: number,
  cargoTons: number,
): {
  name: string;
  value: string;
} {
  const totalProfit = route.profit_per_ton * cargoTons;
  const fromTypeBadge = formatStationTypeBadge({
    stationType: route.from_station_type,
    isFleetCarrier: route.from_is_carrier,
  });
  const toTypeBadge = formatStationTypeBadge({
    stationType: route.to_station_type,
    isFleetCarrier: route.to_is_carrier,
  });
  const fromFactionStr = route.from_faction ? ` • 🚩 *${route.from_faction}*` : "";
  const toFactionStr = route.to_faction
    ? ` • 🚩 *${route.to_faction}*${route.to_faction_state ? ` (${route.to_faction_state})` : ""}`
    : "";

  return {
    name: `#${index + 1} • ${route.commodity_name} — ${formatCredits(route.profit_per_ton, true)}/t (${formatCredits(totalProfit, true)} / ${cargoTons}t) • In-System`,
    value:
      `**📤 Buy:** **${route.from_station}** ${formatPadBadge(route.from_pad)} • ${fromTypeBadge} • ${formatDistanceLs(route.from_ls)}${fromFactionStr}\n` +
      `└ Price: **${formatCredits(route.buy_price)}** • Stock: \`${formatNumber(route.stock)}\` • ${formatRelativeTimestamp(route.buy_updated_at)}\n` +
      `**📥 Sell:** **${route.to_station}** ${formatPadBadge(route.to_pad)} • ${toTypeBadge} • ${formatDistanceLs(route.to_ls)}${toFactionStr}\n` +
      `└ Price: **${formatCredits(route.sell_price)}** • Demand: \`${formatNumber(route.demand)}\` • ${formatRelativeTimestamp(route.sell_updated_at)}`,
  };
}

const internalRouteCommand: BotCommand = {
  category: "Trading",
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("internal-route")
    .setDescription(
      "Finds profitable internal commodity trade routes between markets within the same star system.",
    )
    .addStringOption((opt) =>
      opt
        .setName("system")
        .setDescription("Star system to search within (e.g. Heverty)")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("from_station")
        .setDescription("Specific buying market in the system")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("to_station")
        .setDescription("Specific selling market in the system")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("commodity")
        .setDescription("Filter by a specific commodity (e.g. Gold, Agronomic Treatment)")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("to_faction")
        .setDescription("Filter destination markets by controlling minor faction")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("min_pad")
        .setDescription("Minimum landing pad size required on both ends (default: Large)")
        .addChoices(
          { name: "Large (L)", value: "L" },
          { name: "Medium (M or L)", value: "M" },
          { name: "Any (S, M, L, or Unknown)", value: "Any" },
        )
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("min_stock")
        .setDescription("Minimum supply stock at buying market (default: 500)")
        .setMinValue(1)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("min_demand")
        .setDescription("Minimum demand at selling market (default: 0)")
        .setMinValue(0)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("max_ls")
        .setDescription("Max supercruise distance from star in ls (default: Any)")
        .setMinValue(10)
        .setRequired(false),
    )
    .addBooleanOption((opt) =>
      opt
        .setName("include_carriers")
        .setDescription("Include public Fleet Carriers (default: false)")
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("cargo_capacity")
        .setDescription("Ship cargo capacity in tons for trip profit calculation (default: 784)")
        .setMinValue(1)
        .setMaxValue(2000)
        .setRequired(false),
    ),

  autocomplete: createAutocomplete({
    system: autocompleteSystem,
    from_station: autocompleteStationFor("system"),
    to_station: autocompleteStationFor("system"),
    commodity: autocompleteCommodity,
    to_faction: autocompleteFactionFor("system"),
  }),

  async execute(interaction) {
    await interaction.deferReply();

    const systemQuery = interaction.options.getString("system", true);
    const fromStation = interaction.options.getString("from_station");
    const toStation = interaction.options.getString("to_station");
    const commodityQuery = interaction.options.getString("commodity");
    const toFaction = interaction.options.getString("to_faction");
    const minPad = (interaction.options.getString("min_pad") ?? "L") as PadFilter;
    const minStock = interaction.options.getInteger("min_stock") ?? 500;
    const minDemand = interaction.options.getInteger("min_demand") ?? 0;
    const maxLs = interaction.options.getInteger("max_ls");
    const includeCarriers = interaction.options.getBoolean("include_carriers") ?? false;
    const cargoCapacity = interaction.options.getInteger("cargo_capacity") ?? 784;

    const { system, commodity, routes } = await findInternalTradeRoutes({
      system: systemQuery,
      fromStation,
      toStation,
      commodityQuery,
      toFaction,
      minPad,
      minStock,
      minDemand,
      maxLs,
      includeCarriers,
      limit: 25,
    });

    if (!system) {
      const notFoundEmbed = createPphEmbed({
        title: "❓ Star System Not Found",
        description: `Could not find star system **${systemQuery}** in the database or EDSM.`,
        color: PPH_COLORS.ERROR,
      });
      await interaction.editReply({ embeds: [notFoundEmbed] });
      return;
    }

    if (commodityQuery && !commodity) {
      const notFoundCommodityEmbed = createPphEmbed({
        title: "❓ Commodity Not Found",
        description: `No commodity matching **${commodityQuery}** was found in the catalog.`,
        color: PPH_COLORS.ERROR,
      });
      await interaction.editReply({ embeds: [notFoundCommodityEmbed] });
      return;
    }

    const fromLabel = fromStation ? `**${fromStation}**` : "Any Market";
    const toLabel = toStation ? `**${toStation}**` : "Any Market";
    const scopeParts = [`**${system.name}** (${fromLabel} ➔ ${toLabel})`];
    if (commodity) scopeParts.push(`Commodity: **${commodity.name}**`);
    if (toFaction) scopeParts.push(`Target Faction: **${toFaction}**`);
    const scopeDesc = scopeParts.join(" • ");

    const maxScLabel = maxLs !== null ? `${formatNumber(maxLs)} ls` : "Any";
    const filterSummary =
      `Pad: \`${minPad}\` • Min Stock: \`${formatNumber(minStock)}\` • Max SC: \`${maxScLabel}\` • ` +
      `Carriers: \`${includeCarriers ? "Yes" : "No"}\` • Cargo: \`${cargoCapacity}t\``;

    const pages: EmbedBuilder[] = [];
    for (let i = 0; i < routes.length; i += ROUTES_PER_PAGE) {
      const slice = routes.slice(i, i + ROUTES_PER_PAGE);
      const embed = createPphEmbed({
        title: `🔄 Internal Trade Routes — ${system.name}`,
        description: `${scopeDesc}\n${filterSummary}`,
        color: PPH_COLORS.PROFIT,
      });

      for (let j = 0; j < slice.length; j++) {
        embed.addFields(formatInternalRouteField(slice[j]!, i + j, cargoCapacity));
      }
      pages.push(embed);
    }

    await sendPaginatedEmbeds(interaction, pages, {
      emptyTitle: `No Profitable Internal Routes Found in ${system.name}`,
      emptyDescription:
        `No profitable in-system trade routes matched ${scopeDesc} (${filterSummary}).\n` +
        `Try setting \`min_pad: Any\`, lowering \`min_stock\`, increasing \`max_ls\`, or enabling \`include_carriers: true\`.`,
    });
  },
};

export default internalRouteCommand;
