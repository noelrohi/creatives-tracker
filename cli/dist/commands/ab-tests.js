import { compactObject, runCommand } from "../utils.js";
export function registerAbTestCommands(program) {
    const abTests = program.command("ab-tests").description("Manage A/B tests");
    abTests.command("list").action(async (_, command) => {
        await runCommand(command, (client) => client.abTest.list.query());
    });
    abTests.command("get <id>").action(async (id, command) => {
        await runCommand(command, (client) => client.abTest.getById.query({ id }));
    });
    abTests
        .command("create")
        .option("--name <name>")
        .option("--hypothesis <hypothesis>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.abTest.create.mutate(compactObject({
            name: options.name,
            hypothesis: options.hypothesis,
        })));
    });
    abTests
        .command("update <id>")
        .option("--name <name>")
        .option("--hypothesis <hypothesis>")
        .option("--status <status>")
        .option("--winner-variant-id <winnerVariantId>")
        .action(async (id, options, command) => {
        await runCommand(command, (client) => client.abTest.update.mutate(compactObject({
            id,
            name: options.name,
            hypothesis: options.hypothesis,
            status: options.status,
            winnerVariantId: options.winnerVariantId,
        })));
    });
    abTests.command("delete <id>").action(async (id, command) => {
        await runCommand(command, async (client) => {
            await client.abTest.delete.mutate({ id });
            return { deleted: true, id };
        });
    });
    abTests
        .command("add-variant <abTestId>")
        .requiredOption("--ad-id <adId>")
        .requiredOption("--label <label>")
        .action(async (abTestId, options, command) => {
        await runCommand(command, (client) => client.abTest.addVariant.mutate({
            abTestId,
            adId: options.adId,
            label: options.label,
        }));
    });
    abTests.command("remove-variant <id>").action(async (id, command) => {
        await runCommand(command, async (client) => {
            await client.abTest.removeVariant.mutate({ id });
            return { removed: true, id };
        });
    });
}
