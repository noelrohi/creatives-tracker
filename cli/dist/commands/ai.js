import { compactObject, parseInteger, runCommand } from "../utils.js";
export function registerAiCommands(program) {
    const ai = program.command("ai").description("Run AI helpers");
    ai
        .command("analyze")
        .requiredOption("--asset-url <assetUrl>")
        .option("--name <name>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.ai.analyze.mutate({
            assetUrl: options.assetUrl,
            name: options.name,
        }));
    });
    ai
        .command("generate-brief")
        .option("--format <format>")
        .option("--awareness-level <awarenessLevel>")
        .option("--persona <persona>")
        .option("--angle <angle>")
        .option("--limit <limit>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.ai.generateBrief.mutate(compactObject({
            format: options.format,
            awarenessLevel: options.awarenessLevel,
            persona: options.persona,
            angle: options.angle,
            limit: parseInteger(options.limit),
        })));
    });
}
