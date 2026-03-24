import { runCommand } from "../utils.js";
export function registerTagCommands(program) {
    const tags = program.command("tags").description("Manage entity tags");
    tags.command("search [query]").action(async (query, command) => {
        await runCommand(command, (client) => client.tag.search.query(query ? { query } : undefined));
    });
    tags
        .command("list")
        .requiredOption("--entity-type <entityType>")
        .requiredOption("--entity-id <entityId>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.tag.listForEntity.query({
            entityType: options.entityType,
            entityId: options.entityId,
        }));
    });
    tags
        .command("attach")
        .requiredOption("--entity-type <entityType>")
        .requiredOption("--entity-id <entityId>")
        .requiredOption("--tag-name <tagName>")
        .option("--tag-color <tagColor>")
        .action(async (options, command) => {
        await runCommand(command, (client) => client.tag.attach.mutate({
            entityType: options.entityType,
            entityId: options.entityId,
            tagName: options.tagName,
            tagColor: options.tagColor,
        }));
    });
    tags
        .command("detach")
        .requiredOption("--entity-type <entityType>")
        .requiredOption("--entity-id <entityId>")
        .requiredOption("--tag-id <tagId>")
        .action(async (options, command) => {
        await runCommand(command, async (client) => {
            await client.tag.detach.mutate({
                entityType: options.entityType,
                entityId: options.entityId,
                tagId: options.tagId,
            });
            return {
                detached: true,
                entityType: options.entityType,
                entityId: options.entityId,
                tagId: options.tagId,
            };
        });
    });
}
