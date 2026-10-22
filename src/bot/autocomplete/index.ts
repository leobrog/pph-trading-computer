import type {
  ApplicationCommandOptionChoiceData,
  AutocompleteInteraction,
} from "discord.js";
import {
  searchCommodities,
  searchFactions,
  searchStations,
  searchSystems,
} from "../../db/queries/autocomplete.ts";

export type AutocompleteProvider = (
  focusedValue: string,
  interaction: AutocompleteInteraction,
) => Promise<ApplicationCommandOptionChoiceData<string>[]>;

function truncateChoice(text: string, maxLen = 100): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

/**
 * Autocomplete provider for Star System names.
 */
export const autocompleteSystem: AutocompleteProvider = async (focusedValue) => {
  const rows = await searchSystems(focusedValue, 25);
  return rows.map((row) => {
    const suffix =
      row.is_under_colonisation && (row.population ?? 0) === 0 ? " [Colonising]" : "";
    return {
      name: truncateChoice(`${row.name}${suffix}`),
      value: truncateChoice(row.name),
    };
  });
};

/**
 * Creates a context-aware Station autocomplete provider that automatically filters
 * stations by a companion system option (e.g., `from_system`, `to_system`, `target_system`, `system`)
 * if the user has already filled it in.
 */
export function autocompleteStationFor(systemOptionName = "system"): AutocompleteProvider {
  return async (focusedValue, interaction) => {
    let sysValue: string | null = null;
    try {
      sysValue = interaction.options.getString(systemOptionName);
    } catch {
      sysValue = null;
    }

    const rows = await searchStations(focusedValue, sysValue, 25);
    return rows.map((row) => {
      const icon = row.is_colonisation_vessel
        ? "🏗️ "
        : row.is_fleet_carrier
          ? "🛸 "
          : "";
      const pad = row.max_landing_pad ? ` [${row.max_landing_pad}]` : "";
      const ls =
        row.distance_to_arrival_ls != null
          ? ` (${Math.round(row.distance_to_arrival_ls).toLocaleString()} ls)`
          : "";

      const label = sysValue
        ? `${icon}${row.name}${pad}${ls}`
        : `${icon}${row.name} — ${row.system_name}${pad}`;

      return {
        name: truncateChoice(label),
        value: truncateChoice(row.name),
      };
    });
  };
}

/**
 * Default Station autocomplete provider (checks `system` option if present).
 */
export const autocompleteStation: AutocompleteProvider = autocompleteStationFor("system");

/**
 * Autocomplete provider for Commodities (matches display name, symbol, or category).
 */
export const autocompleteCommodity: AutocompleteProvider = async (focusedValue) => {
  const rows = await searchCommodities(focusedValue, 25);
  return rows.map((row) => {
    const rareTag = row.is_rare ? " • Rare" : "";
    return {
      name: truncateChoice(`${row.name} (${row.category}${rareTag})`),
      value: truncateChoice(row.name),
    };
  });
};

/**
 * Creates a context-aware Minor Faction autocomplete provider that prioritizes
 * factions present in `systemOptionName` when filled in.
 */
export function autocompleteFactionFor(
  systemOptionName = "target_system",
): AutocompleteProvider {
  return async (focusedValue, interaction) => {
    let sysValue: string | null = null;
    try {
      sysValue = interaction.options.getString(systemOptionName);
    } catch {
      sysValue = null;
    }

    const rows = await searchFactions(focusedValue, sysValue, 25);
    return rows.map((row) => {
      const inf =
        typeof row.influence === "number" ? ` (${(row.influence * 100).toFixed(1)}%)` : "";
      const gov = row.government ? ` • ${row.government}` : "";
      return {
        name: truncateChoice(`${row.name}${inf}${gov}`),
        value: truncateChoice(row.name),
      };
    });
  };
}

/**
 * Default Minor Faction autocomplete provider.
 */
export const autocompleteFaction: AutocompleteProvider =
  autocompleteFactionFor("target_system");

/**
 * Declarative helper that maps slash command option names to `AutocompleteProvider` functions.
 */
export function createAutocomplete(
  providers: Record<string, AutocompleteProvider>,
): (interaction: AutocompleteInteraction) => Promise<void> {
  return async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    const provider = providers[focused.name];
    if (!provider) {
      await interaction.respond([]);
      return;
    }

    try {
      const choices = await provider(focused.value, interaction);
      await interaction.respond(choices.slice(0, 25));
    } catch (err) {
      console.error(
        `[Autocomplete] Error resolving option "${focused.name}" ("${focused.value}"):`,
        err,
      );
      try {
        await interaction.respond([]);
      } catch {
        // Ignore if interaction already expired
      }
    }
  };
}
