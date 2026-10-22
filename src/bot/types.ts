import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export type CommandCategory = "Trading" | "BGS" | "Utility";

export type SlashCommandDefinition =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export interface BotCommand {
  /** Category label used in /help and logging */
  category: CommandCategory;
  /** discord.js SlashCommandBuilder definition */
  data: SlashCommandDefinition;
  /** Main slash command execution handler */
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  /** Optional autocomplete handler (can use declarative createAutocomplete helper) */
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
  /** Optional per-user cooldown in seconds (default: 2) */
  cooldownSeconds?: number;
}
