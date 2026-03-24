import { compactObject, parseList, runCommand } from "../utils.js";
export function registerLandingPageCommands(program) {
    const landingPages = program
        .command("landing-pages")
        .description("Manage landing pages and versions");
    landingPages.command("list").action(async (_, command) => {
        await runCommand(command, (client) => client.landingPage.list.query());
    });
    landingPages.command("get <id>").action(async (id, command) => {
        await runCommand(command, (client) => client.landingPage.getById.query({ id }));
    });
    landingPages
        .command("create")
        .option("--name <name>")
        .option("--url <url>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.landingPage.create.mutate(compactObject({
            name: options.name,
            url: options.url,
        })));
    });
    landingPages
        .command("update <id>")
        .option("--name <name>")
        .option("--url <url>")
        .action(async (id, options, command) => {
        await runCommand(command, (client) => client.landingPage.update.mutate(compactObject({
            id,
            name: options.name,
            url: options.url,
        })));
    });
    landingPages.command("delete <id>").action(async (id, command) => {
        await runCommand(command, async (client) => {
            await client.landingPage.delete.mutate({ id });
            return { deleted: true, id };
        });
    });
    landingPages.command("duplicate <id>").action(async (id, command) => {
        await runCommand(command, (client) => client.landingPage.duplicate.mutate({ id }));
    });
    landingPages.command("versions <landingPageId>").action(async (landingPageId, command) => {
        await runCommand(command, (client) => client.landingPage.listVersions.query({ landingPageId }));
    });
    landingPages
        .command("add-version <landingPageId>")
        .requiredOption("--page-type <pageType>")
        .requiredOption("--hero-copy <heroCopy>")
        .requiredOption("--benefits <benefits>")
        .requiredOption("--social-proof-type <socialProofType>")
        .requiredOption("--funnel-position <funnelPosition>")
        .option("--url <url>")
        .option("--screenshot-url <screenshotUrl>")
        .option("--notes <notes>")
        .action(async (landingPageId, options, command) => {
        await runCommand(command, (client) => client.landingPage.createVersion.mutate({
            landingPageId,
            pageType: options.pageType,
            heroCopy: options.heroCopy,
            benefits: parseList(options.benefits) ?? [],
            socialProofType: parseList(options.socialProofType) ?? [],
            funnelPosition: options.funnelPosition,
            url: options.url,
            screenshotUrl: options.screenshotUrl,
            notes: options.notes,
        }));
    });
    landingPages
        .command("update-version <id>")
        .option("--page-type <pageType>")
        .option("--hero-copy <heroCopy>")
        .option("--benefits <benefits>")
        .option("--social-proof-type <socialProofType>")
        .option("--funnel-position <funnelPosition>")
        .option("--url <url>")
        .option("--screenshot-url <screenshotUrl>")
        .option("--notes <notes>")
        .action(async (id, options, command) => {
        await runCommand(command, (client) => client.landingPage.updateVersion.mutate(compactObject({
            id,
            pageType: options.pageType,
            heroCopy: options.heroCopy,
            benefits: options.benefits
                ? (parseList(options.benefits) ?? [])
                : undefined,
            socialProofType: options.socialProofType
                ? (parseList(options.socialProofType) ?? [])
                : undefined,
            funnelPosition: options.funnelPosition,
            url: options.url,
            screenshotUrl: options.screenshotUrl,
            notes: options.notes,
        })));
    });
    landingPages.command("delete-version <id>").action(async (id, command) => {
        await runCommand(command, async (client) => {
            await client.landingPage.deleteVersion.mutate({ id });
            return { deleted: true, id };
        });
    });
    landingPages.command("duplicate-version <id>").action(async (id, command) => {
        await runCommand(command, (client) => client.landingPage.duplicateVersion.mutate({ id }));
    });
}
