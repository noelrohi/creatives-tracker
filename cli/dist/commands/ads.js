import { compactObject, readCsvRows, runCommand } from "../utils.js";
const AD_IMPORT_INTEGER_FIELDS = ["conversions", "impressions", "reach"];
export function registerAdCommands(program) {
    const ads = program.command("ads").description("Manage ads");
    ads.command("list").action(async (_, command) => {
        await runCommand(command, (client) => client.ad.list.query());
    });
    ads.command("get <id>").action(async (id, command) => {
        await runCommand(command, (client) => client.ad.getById.query({ id }));
    });
    ads.command("by-set <adSetId>").action(async (adSetId, command) => {
        await runCommand(command, (client) => client.ad.listByAdSet.query({ adSetId }));
    });
    ads.command("by-creative <adCreativeId>").action(async (adCreativeId, command) => {
        await runCommand(command, (client) => client.ad.listByCreative.query({ adCreativeId }));
    });
    ads
        .command("create")
        .requiredOption("--ad-set-id <adSetId>")
        .option("--name <name>")
        .option("--creative-id <adCreativeId>")
        .option("--landing-page-version-id <landingPageVersionId>")
        .option("--meta-id <metaId>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.ad.create.mutate(compactObject({
            adSetId: options.adSetId,
            name: options.name,
            adCreativeId: options.creativeId,
            landingPageVersionId: options.landingPageVersionId,
            metaId: options.metaId,
        })));
    });
    ads
        .command("update <id>")
        .option("--name <name>")
        .option("--ad-set-id <adSetId>")
        .option("--creative-id <adCreativeId>")
        .option("--landing-page-version-id <landingPageVersionId>")
        .option("--status <status>")
        .option("--meta-id <metaId>")
        .option("--notes <notes>")
        .action(async (id, options, command) => {
        await runCommand(command, (client) => client.ad.update.mutate(compactObject({
            id,
            name: options.name,
            adSetId: options.adSetId,
            adCreativeId: options.creativeId,
            landingPageVersionId: options.landingPageVersionId,
            status: options.status,
            metaId: options.metaId,
            notes: options.notes,
        })));
    });
    ads.command("delete <id>").action(async (id, command) => {
        await runCommand(command, async (client) => {
            await client.ad.delete.mutate({ id });
            return { deleted: true, id };
        });
    });
    ads
        .command("import")
        .requiredOption("--ad-set-id <adSetId>")
        .requiredOption("--file <file>")
        .action(async (options, command) => {
        await runCommand(command, async (client) => {
            const rows = await readCsvRows(options.file, AD_IMPORT_INTEGER_FIELDS);
            return client.ad.bulkImport.mutate({
                adSetId: options.adSetId,
                rows: rows.map((row) => ({
                    name: String(row.name),
                    roas: row.roas !== undefined ? String(row.roas) : undefined,
                    cpa: row.cpa !== undefined ? String(row.cpa) : undefined,
                    ctr: row.ctr !== undefined ? String(row.ctr) : undefined,
                    conversionRate: row.conversionRate !== undefined
                        ? String(row.conversionRate)
                        : undefined,
                    spend: row.spend !== undefined ? String(row.spend) : undefined,
                    conversions: typeof row.conversions === "number" ? row.conversions : undefined,
                    impressions: typeof row.impressions === "number" ? row.impressions : undefined,
                    reach: typeof row.reach === "number" ? row.reach : undefined,
                    frequency: row.frequency !== undefined ? String(row.frequency) : undefined,
                    cpm: row.cpm !== undefined ? String(row.cpm) : undefined,
                    qualityRanking: row.qualityRanking !== undefined
                        ? String(row.qualityRanking)
                        : undefined,
                    engagementRateRanking: row.engagementRateRanking !== undefined
                        ? String(row.engagementRateRanking)
                        : undefined,
                    conversionRateRanking: row.conversionRateRanking !== undefined
                        ? String(row.conversionRateRanking)
                        : undefined,
                    dateStart: row.dateStart !== undefined ? String(row.dateStart) : undefined,
                    dateEnd: row.dateEnd !== undefined ? String(row.dateEnd) : undefined,
                })),
            });
        });
    });
}
