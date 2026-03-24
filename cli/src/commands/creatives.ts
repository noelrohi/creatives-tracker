import { Command } from "commander";
import { compactObject, parseList, readCsvRows, runCommand } from "../utils.js";

const CREATIVE_IMPORT_INTEGER_FIELDS = [
  "conversions",
  "impressions",
  "reach",
  "linkClicks",
  "clicksAll",
  "landingPageViews",
  "addToCart",
  "initiateCheckout",
  "videoViews3s",
  "videoThruplay",
];

export function registerCreativeCommands(program: Command) {
  const creatives = program
    .command("creatives")
    .description("Manage ad creatives");

  creatives
    .command("list")
    .option("--format <format>")
    .option("--awareness-level <awarenessLevel>")
    .option("--search <search>")
    .option("--account-id <accountId>")
    .option("--untagged-only", "Show only untagged creatives")
    .action(async (options, command) => {
      await runCommand(command, (client) =>
        client.adCreative.list.query(
          compactObject({
            format: options.format,
            awarenessLevel: options.awarenessLevel,
            search: options.search,
            accountId: options.accountId,
            untaggedOnly: options.untaggedOnly || undefined,
          }),
        ),
      );
    });

  creatives.command("get <id>").action(async (id, command) => {
    await runCommand(command, (client) =>
      client.adCreative.getById.query({ id }),
    );
  });

  creatives.command("performance <id>").action(async (id, command) => {
    await runCommand(command, (client) =>
      client.adCreative.getPerformance.query({ id }),
    );
  });

  creatives
    .command("create")
    .option("--name <name>")
    .action(async (options, command) => {
      await runCommand(command, (client) =>
        client.adCreative.create.mutate(
          compactObject({
            name: options.name,
          }),
        ),
      );
    });

  creatives
    .command("update <id>")
    .option("--name <name>")
    .option("--asset-url <assetUrl>")
    .option("--format <format>")
    .option("--angle <angle>")
    .option("--persona <persona>")
    .option("--awareness-level <awarenessLevel>")
    .option("--hook <hook>")
    .option("--tone <tone>")
    .option("--cta <cta>")
    .option("--landing-page-id <landingPageId>")
    .option("--notes <notes>")
    .action(async (id, options, command) => {
      await runCommand(command, (client) =>
        client.adCreative.update.mutate({
          id,
          ...compactObject({
            name: options.name,
            assetUrl: options.assetUrl,
            format: options.format,
            angle: options.angle,
            persona: options.persona,
            awarenessLevel: options.awarenessLevel,
            hook: options.hook,
            tone: parseList(options.tone),
            cta: options.cta,
            landingPageId: options.landingPageId,
            notes: options.notes,
          }),
        }),
      );
    });

  creatives.command("delete <id>").action(async (id, command) => {
    await runCommand(command, async (client) => {
      await client.adCreative.delete.mutate({ id });
      return { deleted: true, id };
    });
  });

  creatives.command("duplicate <id>").action(async (id, command) => {
    await runCommand(command, (client) =>
      client.adCreative.duplicate.mutate({ id }),
    );
  });

  creatives
    .command("bulk-import")
    .requiredOption("--file <file>")
    .option("--account-id <accountId>")
    .action(async (options, command) => {
      await runCommand(command, async (client) => {
        const rows = await readCsvRows(
          options.file,
          CREATIVE_IMPORT_INTEGER_FIELDS,
        );
        return client.adCreative.bulkImport.mutate({
          accountId: options.accountId,
          rows: rows.map((row) => ({
            name: String(row.name),
            roas: row.roas !== undefined ? String(row.roas) : undefined,
            cpa: row.cpa !== undefined ? String(row.cpa) : undefined,
            ctr: row.ctr !== undefined ? String(row.ctr) : undefined,
            conversionRate:
              row.conversionRate !== undefined
                ? String(row.conversionRate)
                : undefined,
            spend: row.spend !== undefined ? String(row.spend) : undefined,
            conversions:
              typeof row.conversions === "number" ? row.conversions : undefined,
            impressions:
              typeof row.impressions === "number" ? row.impressions : undefined,
            reach: typeof row.reach === "number" ? row.reach : undefined,
            frequency:
              row.frequency !== undefined ? String(row.frequency) : undefined,
            cpm: row.cpm !== undefined ? String(row.cpm) : undefined,
            qualityRanking:
              row.qualityRanking !== undefined
                ? String(row.qualityRanking)
                : undefined,
            engagementRateRanking:
              row.engagementRateRanking !== undefined
                ? String(row.engagementRateRanking)
                : undefined,
            conversionRateRanking:
              row.conversionRateRanking !== undefined
                ? String(row.conversionRateRanking)
                : undefined,
            linkClicks:
              typeof row.linkClicks === "number" ? row.linkClicks : undefined,
            clicksAll:
              typeof row.clicksAll === "number" ? row.clicksAll : undefined,
            cpc: row.cpc !== undefined ? String(row.cpc) : undefined,
            ctrLinkClick:
              row.ctrLinkClick !== undefined ? String(row.ctrLinkClick) : undefined,
            landingPageViews:
              typeof row.landingPageViews === "number"
                ? row.landingPageViews
                : undefined,
            costPerLpv:
              row.costPerLpv !== undefined ? String(row.costPerLpv) : undefined,
            purchaseValue:
              row.purchaseValue !== undefined
                ? String(row.purchaseValue)
                : undefined,
            addToCart:
              typeof row.addToCart === "number" ? row.addToCart : undefined,
            initiateCheckout:
              typeof row.initiateCheckout === "number"
                ? row.initiateCheckout
                : undefined,
            costPerAddToCart:
              row.costPerAddToCart !== undefined
                ? String(row.costPerAddToCart)
                : undefined,
            videoViews3s:
              typeof row.videoViews3s === "number" ? row.videoViews3s : undefined,
            videoThruplay:
              typeof row.videoThruplay === "number"
                ? row.videoThruplay
                : undefined,
            videoAvgWatchTime:
              row.videoAvgWatchTime !== undefined
                ? String(row.videoAvgWatchTime)
                : undefined,
            country: row.country !== undefined ? String(row.country) : undefined,
            platform:
              row.platform !== undefined ? String(row.platform) : undefined,
            placement:
              row.placement !== undefined ? String(row.placement) : undefined,
            device: row.device !== undefined ? String(row.device) : undefined,
            age: row.age !== undefined ? String(row.age) : undefined,
            gender: row.gender !== undefined ? String(row.gender) : undefined,
            delivery:
              row.delivery !== undefined ? String(row.delivery) : undefined,
            adId: row.adId !== undefined ? String(row.adId) : undefined,
            campaignName:
              row.campaignName !== undefined
                ? String(row.campaignName)
                : undefined,
            campaignId:
              row.campaignId !== undefined ? String(row.campaignId) : undefined,
            adSetName:
              row.adSetName !== undefined ? String(row.adSetName) : undefined,
            adSetId:
              row.adSetId !== undefined ? String(row.adSetId) : undefined,
            dateStart: String(row.dateStart),
            dateEnd: String(row.dateEnd),
          })),
        });
      });
    });
}
