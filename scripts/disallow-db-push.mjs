const target = process.argv[2] ?? "database";

console.error(
  [
    `Direct schema push is disabled for ${target}.`,
    "Use migration-based workflows instead:",
    "  1. bun run db:generate",
    "  2. bun run db:migrate",
  ].join("\n"),
);

process.exit(1);
