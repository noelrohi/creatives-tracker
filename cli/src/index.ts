#!/usr/bin/env node

import { Command } from "commander";
import { registerAccountsCommands } from "./commands/accounts.js";
import { registerAdCommands } from "./commands/ads.js";
import { registerAdSetCommands } from "./commands/ad-sets.js";
import { registerCampaignCommands } from "./commands/campaigns.js";
import { registerCreativeCommands } from "./commands/creatives.js";
import { registerMetaSyncCommands } from "./commands/meta-sync.js";
import { registerTagCommands } from "./commands/tags.js";

async function main() {
  const program = new Command();

  program
    .name("adsolute")
    .description("Typed CLI for the Adsolute tRPC API")
    .option("--url <url>", "API base URL, defaults to ADSOLUTE_API_URL or http://localhost:3000")
    .option("--api-key <key>", "Organization API key, defaults to ADSOLUTE_API_KEY")
    .option("--table", "Render output in a table when possible")
    .showHelpAfterError();

  registerAccountsCommands(program);
  registerCampaignCommands(program);
  registerAdSetCommands(program);
  registerAdCommands(program);
  registerCreativeCommands(program);
  registerMetaSyncCommands(program);
  registerTagCommands(program);

  await program.parseAsync(process.argv);
}

await main();
