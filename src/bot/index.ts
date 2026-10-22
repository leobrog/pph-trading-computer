import {
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  MessageFlags,
} from "discord.js";
import { deploySlashCommands } from "../../scripts/deploy-commands.ts";
import { env } from "../config/env.ts";
import { checkDatabaseConnection, closeDatabase } from "../db/index.ts";
import { loadCommands } from "./registry.ts";
import type { BotCommand } from "./types.ts";
import { createPphEmbed, PPH_COLORS } from "./ui/embeds.ts";

const userCooldowns = new Map<string, number>();

function checkCooldown(userId: string, command: BotCommand): number {
  const cooldownSec = command.cooldownSeconds ?? 2;
  if (cooldownSec <= 0) return 0;

  const key = `${command.data.name}:${userId}`;
  const now = Date.now();
  const expiresAt = userCooldowns.get(key) ?? 0;

  if (now < expiresAt) {
    return Math.ceil((expiresAt - now) / 1000);
  }

  userCooldowns.set(key, now + cooldownSec * 1000);
  return 0;
}

async function handleInteraction(
  interaction: Interaction,
  commands: Map<string, BotCommand>,
): Promise<void> {
  if (interaction.isAutocomplete()) {
    const command = commands.get(interaction.commandName);
    if (!command?.autocomplete) {
      await interaction.respond([]);
      return;
    }
    await command.autocomplete(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = commands.get(interaction.commandName);
  if (!command) {
    await interaction.reply({
      content: `Unknown command \`/${interaction.commandName}\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const remainingCooldown = checkCooldown(interaction.user.id, command);
  if (remainingCooldown > 0) {
    await interaction.reply({
      content: `⏳ Please wait **${remainingCooldown}s** before running \`/${command.data.name}\` again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[Bot] Error executing /${command.data.name}:`, err);
    const errEmbed = createPphEmbed({
      title: "⚠️ Command Execution Error",
      description:
        err instanceof Error
          ? `An error occurred while executing \`/${command.data.name}\`:\n\`\`\`\n${err.message}\n\`\`\``
          : "An unexpected error occurred while processing your request.",
      color: PPH_COLORS.ERROR,
    });

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ embeds: [errEmbed], components: [] });
      } else {
        await interaction.reply({ embeds: [errEmbed], flags: MessageFlags.Ephemeral });
      }
    } catch {
      // Ignore if interaction token expired
    }
  }
}

async function main(): Promise<void> {
  console.log("=== PPH Trading Computer — Discord Bot Service ===");

  const dbInfo = await checkDatabaseConnection();
  console.log(`[Bot] Connected to PostgreSQL database "${dbInfo.database}"`);

  const commands = await loadCommands();
  console.log(`[Bot] Auto-discovered ${commands.size} slash command(s):`);
  for (const cmd of commands.values()) {
    console.log(`  • /${cmd.data.name} [${cmd.category}] — ${cmd.data.description}`);
  }

  const token = env.discord.token;
  if (!token || token.startsWith("your_discord_")) {
    console.warn(
      "[Bot] DISCORD_TOKEN is not configured in .env. Standing by until DISCORD_TOKEN is set...",
    );
    const standbyInterval = setInterval(() => {}, 60_000);
    const shutdownStandby = async () => {
      clearInterval(standbyInterval);
      await closeDatabase();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdownStandby());
    process.on("SIGTERM", () => void shutdownStandby());
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[Bot] Ready! Logged in as ${readyClient.user.tag}`);

    if (env.discord.clientId && !env.discord.clientId.startsWith("your_discord_")) {
      try {
        await deploySlashCommands();
      } catch (err) {
        console.warn("[Bot] Auto command sync warning:", (err as Error).message);
      }
    }
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, commands);
  });

  await client.login(token);

  const shutdown = async (signal: string) => {
    console.log(`\n[Bot] Received ${signal}, shutting down gracefully...`);
    client.destroy();
    await closeDatabase();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[Bot] Fatal startup error:", err);
    process.exit(1);
  });
}
