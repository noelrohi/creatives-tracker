import { compactObject, parseInteger, runCommand } from "../utils.js";
export function registerInsightCommands(program) {
    const insights = program.command("insights").description("Query insights");
    insights
        .command("summary")
        .option("--days <days>")
        .option("--account-id <accountId>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.insights.summary.query(compactObject({
            days: parseInteger(options.days),
            accountId: options.accountId,
        })));
    });
    insights
        .command("by-field")
        .requiredOption("--field <field>")
        .option("--days <days>")
        .option("--account-id <accountId>")
        .option("--date-start <dateStart>")
        .option("--date-end <dateEnd>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.insights.byField.query(compactObject({
            field: options.field,
            days: parseInteger(options.days),
            accountId: options.accountId,
            dateStart: options.dateStart,
            dateEnd: options.dateEnd,
        })));
    });
    insights
        .command("by-angle")
        .option("--limit <limit>")
        .option("--days <days>")
        .option("--account-id <accountId>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.insights.byAngle.query(compactObject({
            limit: parseInteger(options.limit),
            days: parseInteger(options.days),
            accountId: options.accountId,
        })));
    });
    insights
        .command("top-creatives")
        .option("--metric <metric>")
        .option("--limit <limit>")
        .option("--days <days>")
        .option("--account-id <accountId>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.insights.topCreatives.query(compactObject({
            metric: options.metric,
            limit: parseInteger(options.limit),
            days: parseInteger(options.days),
            accountId: options.accountId,
        })));
    });
    insights
        .command("untagged-count")
        .option("--account-id <accountId>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.insights.untaggedCount.query(compactObject({
            accountId: options.accountId,
        })));
    });
}
