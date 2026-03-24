import { Command } from "commander";
import { compactObject, readCsvRows, runCommand } from "../utils.js";

export function registerCampaignCommands(program: Command) {
  const campaigns = program
    .command("campaigns")
    .description("Manage campaigns");

  campaigns.command("list").action(async (command) => {
    await runCommand(command, (client) => client.campaign.list.query());
  });

  campaigns.command("get <id>").action(async (id, command) => {
    await runCommand(command, (client) =>
      client.campaign.getById.query({ id }),
    );
  });

  campaigns
    .command("create")
    .option("--name <name>")
    .option("--meta-id <metaId>")
    .action(async (options, command) => {
      await runCommand(command, (client) =>
        client.campaign.create.mutate(
          compactObject({
            name: options.name,
            metaId: options.metaId,
          }),
        ),
      );
    });

  campaigns
    .command("update <id>")
    .option("--name <name>")
    .option("--objective <objective>")
    .option("--status <status>")
    .option("--meta-id <metaId>")
    .option("--notes <notes>")
    .action(async (id, options, command) => {
      await runCommand(command, (client) =>
        client.campaign.update.mutate({
          id,
          ...compactObject({
            name: options.name,
            objective: options.objective,
            status: options.status,
            metaId: options.metaId,
            notes: options.notes,
          }),
        }),
      );
    });

  campaigns.command("delete <id>").action(async (id, command) => {
    await runCommand(command, async (client) => {
      await client.campaign.delete.mutate({ id });
      return { deleted: true, id };
    });
  });

  campaigns
    .command("import")
    .requiredOption("--file <file>")
    .action(async (options, command) => {
      await runCommand(command, async (client) => {
        const rows = await readCsvRows(options.file);
        return client.campaign.bulkImport.mutate({
          rows: rows.map((row) => ({ name: String(row.name) })),
        });
      });
    });
}
