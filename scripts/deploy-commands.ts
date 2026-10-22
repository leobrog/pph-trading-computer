import { REST, Routes } from "discord.js";
import { loadCommands } from "../src/bot/registry.ts";
import { env } from "../src/config/env.ts";

function isPlaceholder(val: string): boolean {
  return !val || val.startsWith("your_discord_");
}

/**
 * Registers all auto-discovered `*.command.ts` slash commands with Discord's API.
 */
export async function deploySlashCommands(): Promise<number> {
  const token = env.discord.token;
  const clientId = env.discord.clientId;
  const guildId = env.discord.guildId;

  if (isPlaceholder(token) || isPlaceholder(clientId)) {
    throw new Error(
      "Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment. Configure them in .env before deploying commands.",
    );
  }

  const commands = await loadCommands();
  const payload = Array.from(commands.values()).map((cmd) => cmd.data.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);

  if (!isPlaceholder(guildId)) {
    console.log(
      `[Deploy] Registering ${payload.length} guild slash command(s) to guild ${guildId}...`,
    );
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: payload,
    });
    console.log(`[Deploy] Successfully registered ${payload.length} guild slash command(s).`);
  } else {
    console.log(`[Deploy] Registering ${payload.length} global slash command(s)...`);
    await rest.put(Routes.applicationCommands(clientId), {
      body: payload,
    });
    console.log(`[Deploy] Successfully registered ${payload.length} global slash command(s).`);
  }

  return payload.length;
}

if (import.meta.main) {
  deploySlashCommands().catch((err) => {
    console.error("[Deploy] Failed to deploy commands:", err);
    process.exit(1);
  });
}
