import { compactObject, runCommand } from "../utils.js";
export function registerAccountsCommands(program) {
    const accounts = program.command("accounts").description("Manage accounts");
    accounts.command("list").action(async (_, command) => {
        await runCommand(command, (client) => client.account.list.query());
    });
    accounts.command("get <id>").action(async (id, command) => {
        await runCommand(command, (client) => client.account.getById.query({ id }));
    });
    accounts
        .command("create")
        .requiredOption("--name <name>")
        .requiredOption("--meta-account-id <metaAccountId>")
        .option("--meta-access-token <metaAccessToken>")
        .option("--notes <notes>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.account.create.mutate({
            name: options.name,
            metaAccountId: options.metaAccountId,
            metaAccessToken: options.metaAccessToken,
            notes: options.notes,
        }));
    });
    accounts
        .command("update <id>")
        .option("--name <name>")
        .option("--meta-account-id <metaAccountId>")
        .option("--meta-access-token <metaAccessToken>")
        .option("--notes <notes>")
        .action(async (id, options, command) => {
        await runCommand(command, (client) => client.account.update.mutate(compactObject({
            id,
            name: options.name,
            metaAccountId: options.metaAccountId,
            metaAccessToken: options.metaAccessToken,
            notes: options.notes,
        })));
    });
    accounts.command("delete <id>").action(async (id, command) => {
        await runCommand(command, async (client) => {
            await client.account.delete.mutate({ id });
            return { deleted: true, id };
        });
    });
}
