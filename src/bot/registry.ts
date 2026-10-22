import { join } from "node:path";
import type { BotCommand } from "./types.ts";

const DEFAULT_COMMANDS_DIR = join(import.meta.dir, "commands");

let cachedCommands: Map<string, BotCommand> | null = null;

/**
 * Dynamically discovers and loads all `*.command.ts` modules under `src/bot/commands/`
 * using `Bun.Glob`. Adding a new command requires only creating a new `*.command.ts` file.
 */
export async function loadCommands(
  commandsDir: string = DEFAULT_COMMANDS_DIR,
  forceReload = false,
): Promise<Map<string, BotCommand>> {
  if (cachedCommands && !forceReload && commandsDir === DEFAULT_COMMANDS_DIR) {
    return cachedCommands;
  }

  const commands = new Map<string, BotCommand>();
  const glob = new Bun.Glob("**/*.command.ts");

  const files: string[] = [];
  for await (const file of glob.scan(commandsDir)) {
    files.push(file);
  }
  files.sort();

  for (const relativePath of files) {
    const fullPath = join(commandsDir, relativePath);
    const mod = (await import(fullPath)) as { default?: BotCommand; command?: BotCommand };
    const cmd = mod.default ?? mod.command;

    if (!cmd || !cmd.data?.name || typeof cmd.execute !== "function") {
      throw new Error(
        `[Registry] Invalid command module at "${relativePath}": must default-export a BotCommand with data and execute()`,
      );
    }

    if (commands.has(cmd.data.name)) {
      throw new Error(
        `[Registry] Duplicate command name "/${cmd.data.name}" found in "${relativePath}"`,
      );
    }

    commands.set(cmd.data.name, cmd);
  }

  if (commandsDir === DEFAULT_COMMANDS_DIR) {
    cachedCommands = commands;
  }

  return commands;
}
