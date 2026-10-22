# Phase 3: Extensible Discord Bot Framework

## Objective
Build the Discord bot service (`src/bot/`) in Bun using `discord.js` v14, designed with a **plug-and-play command architecture** so adding new commands in the future requires zero boilerplate edits to the core bot runner.

---

## 1. Command Plugin Architecture (`src/bot/types.ts` & `src/bot/registry.ts`)

### `BotCommand` Contract
Every command lives in its own file (`src/bot/commands/<category>/<name>.command.ts`) and default-exports a `BotCommand` object:

```ts
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export interface BotCommand {
  /** Category label used in /help and logging (e.g., "Trading", "BGS", "System") */
  category: "Trading" | "BGS" | "Utility";
  /** discord.js SlashCommandBuilder definition */
  data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;
  /** Main slash command execution handler */
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  /** Optional autocomplete handler (can use declarative createAutocomplete helper) */
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}
```

### Zero-Config Auto-Discovery (`src/bot/registry.ts`)
Using `Bun.Glob("**/*.command.ts")`:
* On bot startup, `loadCommands()` scans `src/bot/commands/`, dynamically imports every `*.command.ts` module, validates its `data.name` and `execute` properties, and stores it in a `Map<string, BotCommand>`.
* `scripts/deploy-commands.ts` imports the exact same `loadCommands()` function and registers the commands with Discord's REST API:
  * If `DISCORD_GUILD_ID` is set in `.env`, deploys **instantly** to the PPH Discord server (guild-scoped commands update in <1 second).
  * Also supports global application command deployment.

### How to Add a New Command Later
1. Create `src/bot/commands/<category>/<my-command>.command.ts`.
2. Export a `BotCommand` object (using shared autocomplete and embed helpers).
3. Run `bun run deploy-commands` (or enable auto-sync on bot startup). Done!

---

## 2. Declarative Autocomplete System (`src/bot/autocomplete/index.ts`)

Typing exact Elite Dangerous star system names (e.g., `Synuefe TH-I b55-0`), station names (`Woodroffe Gateway`), commodity names (`Low Temperature Diamonds`), or faction names (`People's Party of Heverty`) on Discord without autocomplete is error-prone.

We will provide a declarative `createAutocomplete(mapping)` helper that maps option names to reusable PostgreSQL trigram query functions:

```ts
export const autocompleteSystem: AutocompleteProvider = async (focusedValue) => {
  // Queries systems table using idx_systems_name_trgm, ordering exact prefix matches first
};

export const autocompleteStation: AutocompleteProvider = async (focusedValue, interaction) => {
  // If user already filled in a 'system' option in the same command,
  // filters stations to that system first! Otherwise searches all stations with system name in label.
};

export const autocompleteCommodity: AutocompleteProvider = async (focusedValue) => {
  // Searches commodities by name or category (e.g. "Platinum (Metals)")
};

export const autocompleteFaction: AutocompleteProvider = async (focusedValue) => {
  // Searches factions table (e.g. "People's Party of Heverty")
};
```

Context-aware station autocomplete is a huge UX win: if a command has both `system` and `station` options and the user selects `system: Heverty` first, the `station` autocomplete automatically lists stations inside `Heverty` (like `Woodroffe Gateway`)!

---

## 3. Shared UI, Embeds & Interactive Pagination (`src/bot/ui/`)

### Standardized Formatting (`src/bot/ui/embeds.ts`)
* **Credits Formatter:** `formatCredits(12450)` $\rightarrow$ `"12,450 CR"`
* **Distance Formatter:**
  * System jump distance: `"24.5 Ly"`
  * Station supercruise distance: `"268 ls"` (with a `⚠️ Far SC` warning badge if `> 10,000 ls`)
* **Landing Pad Badge:** `🟩 L` (Large), `🟨 M` (Medium only), `🟥 S` (Small)
* **Station Type Badge:** Distinguishes Orbital Starports, Outposts, Surface Ports, and `🛸 Fleet Carrier`
* **Freshness Badge:** Uses Discord's native relative timestamp `<t:UNIX_SECONDS:R>` (e.g., `updated 12 minutes ago`).

### Button Pagination (`src/bot/ui/pagination.ts`)
Trade queries often return 15–30 profitable or loss routes. Rather than cramming everything into one wall of text or truncating after 5 results:
* `sendPaginatedEmbeds(interaction, pages)` sends page 1 with `◀ Previous`, `Page 1/5`, and `Next ▶` buttons using `ActionRowBuilder<ButtonBuilder>`.
* Attaches an interaction collector scoped to the command invoker for 5 minutes, disabling buttons cleanly upon expiration.

---

## 4. Verification Criteria for Phase 3
* Bot connects to Discord Gateway, loads commands via `Bun.Glob`, and responds to `/ping` or `/db-status`.
* Context-aware autocomplete responds in `< 50ms` for systems, stations, commodities, and factions.
* Button pagination switches pages smoothly.
