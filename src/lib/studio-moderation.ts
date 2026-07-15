export function moderationReasonFromError(error: unknown) {
  const values: unknown[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || value == null) return;
    if (typeof value === "string") {
      values.push(value);
      return;
    }
    if (typeof value === "object") {
      for (const child of Object.values(value as Record<string, unknown>)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(error, 0);
  const message = values.join(" ").toLowerCase();
  if (!message.includes("moderation_blocked") && !message.includes("moderation")) {
    return null;
  }
  if (/likeness|face|person|identity/.test(message)) return "likeness" as const;
  if (/logo|trademark|brand|copyright|character/.test(message)) return "logo" as const;
  return "moderation" as const;
}
