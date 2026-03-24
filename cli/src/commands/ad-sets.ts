import { Command } from "commander";
import { compactObject, parseList, readCsvRows, runCommand } from "../utils.js";

export function registerAdSetCommands(program: Command) {
  const adSets = program.command("ad-sets").description("Manage ad sets");

  adSets.command("list").action(async (command) => {
    await runCommand(command, (client) => client.adSet.list.query());
  });

  adSets.command("get <id>").action(async (id, command) => {
    await runCommand(command, (client) => client.adSet.getById.query({ id }));
  });

  adSets
    .command("create")
    .requiredOption("--campaign-id <campaignId>")
    .option("--name <name>")
    .option("--meta-id <metaId>")
    .option("--cost-cap <costCap>")
    .option("--daily-budget <dailyBudget>")
    .option("--targeting-method <targetingMethod>")
    .option("--geos <geos>")
    .option("--placements <placements>")
    .option("--demographics <demographics>")
    .option("--schedule-start <scheduleStart>")
    .option("--schedule-end <scheduleEnd>")
    .action(async (options, command) => {
      await runCommand(command, (client) =>
        client.adSet.create.mutate({
          campaignId: options.campaignId,
          ...compactObject({
            name: options.name,
            metaId: options.metaId,
            costCap: options.costCap,
            dailyBudget: options.dailyBudget,
            targetingMethod: parseList(options.targetingMethod),
            geos: parseList(options.geos),
            placements: parseList(options.placements),
            demographics: options.demographics,
            scheduleStart: options.scheduleStart,
            scheduleEnd: options.scheduleEnd,
          }),
        }),
      );
    });

  adSets
    .command("update <id>")
    .option("--campaign-id <campaignId>")
    .option("--name <name>")
    .option("--meta-id <metaId>")
    .option("--cost-cap <costCap>")
    .option("--daily-budget <dailyBudget>")
    .option("--targeting-method <targetingMethod>")
    .option("--geos <geos>")
    .option("--placements <placements>")
    .option("--demographics <demographics>")
    .option("--schedule-start <scheduleStart>")
    .option("--schedule-end <scheduleEnd>")
    .option("--status <status>")
    .option("--notes <notes>")
    .action(async (id, options, command) => {
      await runCommand(command, (client) =>
        client.adSet.update.mutate({
          id,
          ...compactObject({
            campaignId: options.campaignId,
            name: options.name,
            metaId: options.metaId,
            costCap: options.costCap,
            dailyBudget: options.dailyBudget,
            targetingMethod: parseList(options.targetingMethod),
            geos: parseList(options.geos),
            placements: parseList(options.placements),
            demographics: options.demographics,
            scheduleStart: options.scheduleStart,
            scheduleEnd: options.scheduleEnd,
            status: options.status,
            notes: options.notes,
          }),
        }),
      );
    });

  adSets.command("delete <id>").action(async (id, command) => {
    await runCommand(command, async (client) => {
      await client.adSet.delete.mutate({ id });
      return { deleted: true, id };
    });
  });

  adSets
    .command("import")
    .requiredOption("--campaign-id <campaignId>")
    .requiredOption("--file <file>")
    .action(async (options, command) => {
      await runCommand(command, async (client) => {
        const rows = await readCsvRows(options.file);
        return client.adSet.bulkImport.mutate({
          campaignId: options.campaignId,
          rows: rows.map((row) => ({
            name: String(row.name),
            dailyBudget:
              row.dailyBudget !== undefined ? String(row.dailyBudget) : undefined,
            costCap: row.costCap !== undefined ? String(row.costCap) : undefined,
          })),
        });
      });
    });
}
