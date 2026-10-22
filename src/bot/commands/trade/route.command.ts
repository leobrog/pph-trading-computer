import { type EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  findProfitableTradeRoutes,
  type PadFilter,
  type TradeRouteRow,
} from "../../../db/queries/trading.ts";
import {
  autocompleteStationFor,
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
  PPH_COLORS,
} from "../../ui/embeds.ts";
import { sendPaginatedEmbeds } from "../../ui/pagination.ts";

const ROUTES_PER_PAGE = 5;

function formatRouteField(route: TradeRouteRow, index: number, cargoTons: number): {
  name: string;
  value: string;
} {
  const totalProfit = route.profit_per_ton * cargoTons;
  const distStr =
    route.from_system === route.to_system
      ? "In-System"
      : formatDistanceLy(route.distance_ly);

  const fromCarrierTag = route.from_is_carrier ? " 🛸" : "";
  const toCarrierTag = route.to_is_carrier ? " 🛸" : "";
  const toFactionStr = route.to_faction
    ? ` • 🚩 *${route.to_faction}*${route.to_faction_state ? ` (${route.to_faction_state})` : ""}`
    : "";

  return {
    name: `#${index + 1} • ${route.commodity_name} — ${formatCredits(route.profit_per_ton, true)}/t (${formatCredits(totalProfit, true)} / ${cargoTons}t) • ${distStr}`,
    value:
      `**📤 Buy:** **${route.from_station}**${fromCarrierTag} (${route.from_system}) ${formatPadBadge(route.from_pad)} • ${formatDistanceLs(route.from_ls)}\n` +
      `└ Price: **${formatCredits(route.buy_price)}** • Stock: \`${formatNumber(route.stock)}\` • ${formatRelativeTimestamp(route.buy_updated_at)}\n` +
      `**📥 Sell:** **${route.to_station}**${toCarrierTag} (${route.to_system}) ${formatPadBadge(route.to_pad)} • ${formatDistanceLs(route.to_ls)}${toFactionStr}\n` +
      `└ Price: **${formatCredits(route.sell_price)}** • Demand: \`${formatNumber(route.demand)}\` • ${formatRelativeTimestamp(route.sell_updated_at)}`,
  };
}

const tradeRouteCommand: BotCommand = {
  category: "Trading",
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("trade-route")
    .setDescription(
      "Finds the most profitable commodity trade routes between systems/stations or within a jump radius.",
    )
    .addStringOption((opt) =>
      opt
        .setName("from_system")
        .setDescription("Origin star system (e.g. Heverty)")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("from_station")
        .setDescription("Specific origin station in from_system")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("to_system")
        .setDescription("Destination star system (leave blank to search within max_distance_ly)")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("to_station")
        .setDescription("Specific destination station in to_system")
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addNumberOption((opt) =>
      opt
        .setName("max_distance_ly")
        .setDescription("Max jump distance in Light Years when to_system is omitted (default: 50)")
        .setMinValue(1)
        .setMaxValue(250)
        .setRequired(false),
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
        .setDescription("Minimum supply stock at buying station (default: 500)")
        .setMinValue(1)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("min_demand")
        .setDescription("Minimum demand at selling station (default: 0)")
        .setMinValue(0)
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("max_ls")
        .setDescription("Max supercruise distance from star in ls (default: 200000)")
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
    from_system: autocompleteSystem,
    from_station: autocompleteStationFor("from_system"),
    to_system: autocompleteSystem,
    to_station: autocompleteStationFor("to_system"),
  }),

  async execute(interaction) {
    await interaction.deferReply();

    const fromSystem = interaction.options.getString("from_system", true);
    const fromStation = interaction.options.getString("from_station");
    const toSystem = interaction.options.getString("to_system");
    const toStation = interaction.options.getString("to_station");
    const maxDistanceLy = interaction.options.getNumber("max_distance_ly") ?? 50;
    const minPad = (interaction.options.getString("min_pad") ?? "L") as PadFilter;
    const minStock = interaction.options.getInteger("min_stock") ?? 500;
    const minDemand = interaction.options.getInteger("min_demand") ?? 0;
    const maxLs = interaction.options.getInteger("max_ls") ?? 200_000;
    const includeCarriers = interaction.options.getBoolean("include_carriers") ?? false;
    const cargoCapacity = interaction.options.getInteger("cargo_capacity") ?? 784;

    const { origin, routes } = await findProfitableTradeRoutes({
      fromSystem,
      fromStation,
      toSystem,
      toStation,
      maxDistanceLy,
      minPad,
      minStock,
      minDemand,
      maxLs,
      includeCarriers,
      limit: 25,
    });

    if (!origin) {
      const notFoundEmbed = createPphEmbed({
        title: "❓ Origin System Not Found",
        description: `Could not find star system **${fromSystem}** in the database or EDSM.`,
        color: PPH_COLORS.ERROR,
      });
      await interaction.editReply({ embeds: [notFoundEmbed] });
      return;
    }

    const scopeDesc = toSystem
      ? `**${origin.name}**${fromStation ? ` (${fromStation})` : ""} ➔ **${toSystem}**${toStation ? ` (${toStation})` : ""}`
      : `**${origin.name}**${fromStation ? ` (${fromStation})` : ""} ➔ Within **${maxDistanceLy} Ly**`;

    const filterSummary =
      `Pad: \`${minPad}\` • Min Stock: \`${formatNumber(minStock)}\` • Max SC: \`${formatNumber(maxLs)} ls\` • ` +
      `Carriers: \`${includeCarriers ? "Yes" : "No"}\` • Cargo: \`${cargoCapacity}t\``;

    const pages: EmbedBuilder[] = [];
    for (let i = 0; i < routes.length; i += ROUTES_PER_PAGE) {
      const slice = routes.slice(i, i + ROUTES_PER_PAGE);
      const embed = createPphEmbed({
        title: `💰 Profitable Trade Routes — ${origin.name}`,
        description: `${scopeDesc}\n${filterSummary}`,
        color: PPH_COLORS.PROFIT,
      });

      for (let j = 0; j < slice.length; j++) {
        embed.addFields(formatRouteField(slice[j]!, i + j, cargoCapacity));
      }
      pages.push(embed);
    }

    await sendPaginatedEmbeds(interaction, pages, {
      emptyTitle: `No Profitable Routes Found from ${origin.name}`,
      emptyDescription:
        `No profitable trade routes matched ${scopeDesc} (${filterSummary}).\n` +
        `Try increasing \`max_distance_ly\`, setting \`min_pad: Any\`, lowering \`min_stock\`, or enabling \`include_carriers: true\`.`,
    });
  },
};

export default tradeRouteCommand;
