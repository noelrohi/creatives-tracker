import { z } from "zod";
import { generateObject } from "ai";
import { router, baseProcedure } from "../init";
import { openrouter } from "@/lib/ai";
import { db } from "@/db";
import { adCreatives } from "@/schema/ad-creative";
import { ads } from "@/schema/ad";
import { performanceLogs } from "@/schema/performance-log";
import { eq, desc, avg, count, sql, isNotNull } from "drizzle-orm";

const resolutionSchema = z.object({
  format: z
    .enum(["static", "video", "ugc", "carousel"])
    .nullable()
    .describe("The ad format type"),
  angle: z
    .string()
    .nullable()
    .describe("The marketing angle or approach (e.g. 'teeth grinding', 'sleep quality', 'pain relief')"),
  persona: z
    .string()
    .nullable()
    .describe("The target persona (e.g. 'stressed professional', 'new mom', 'athlete')"),
  awarenessLevel: z
    .enum(["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware"])
    .nullable()
    .describe("Eugene Schwartz awareness level of the target audience"),
  hook: z
    .string()
    .nullable()
    .describe("The opening hook or attention-grabber"),
  tone: z
    .array(z.string())
    .nullable()
    .describe("Tone descriptors (e.g. ['clinical', 'urgent'] or ['casual', 'friendly'])"),
  cta: z
    .string()
    .nullable()
    .describe("The call-to-action text or type"),
});

export const aiRouter = router({
  analyze: baseProcedure
    .input(
      z.object({
        assetUrl: z.string().url(),
        name: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { object } = await generateObject({
        model: openrouter("anthropic/claude-sonnet-4"),
        schema: resolutionSchema,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Analyze this ad creative and suggest resolution tags for it. ${input.name ? `The ad is called "${input.name}".` : ""}

Fill in each field based on what you observe:
- format: what type of ad is this?
- angle: what marketing angle or approach is being used?
- persona: who is this targeting?
- awarenessLevel: what Eugene Schwartz awareness level does this target?
- hook: what is the opening hook?
- tone: what tones are used? (array of descriptors)
- cta: what call-to-action is used?

If you can't determine a field from the creative, set it to null.`,
              },
              {
                type: "image",
                image: input.assetUrl,
              },
            ],
          },
        ],
      });

      return object;
    }),

  generateBrief: baseProcedure
    .input(
      z.object({
        format: z.enum(["static", "video", "ugc", "carousel"]).optional(),
        awarenessLevel: z
          .enum(["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware"])
          .optional(),
        persona: z.string().optional(),
        angle: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(5),
      }),
    )
    .mutation(async ({ input }) => {
      // Build conditions for finding matching top performers
      const conditions = [];
      if (input.format) conditions.push(eq(adCreatives.format, input.format));
      if (input.awarenessLevel)
        conditions.push(eq(adCreatives.awarenessLevel, input.awarenessLevel));

      // Get top performing creatives matching constraints
      const topCreatives = await db
        .select({
          name: adCreatives.name,
          format: adCreatives.format,
          angle: adCreatives.angle,
          persona: adCreatives.persona,
          awarenessLevel: adCreatives.awarenessLevel,
          hook: adCreatives.hook,
          tone: adCreatives.tone,
          cta: adCreatives.cta,
          avgRoas: avg(performanceLogs.roas).as("avg_roas"),
          avgCpa: avg(performanceLogs.cpa).as("avg_cpa"),
          totalSpend: sql<string>`sum(${performanceLogs.spend})`.as("total_spend"),
        })
        .from(adCreatives)
        .innerJoin(ads, eq(ads.adCreativeId, adCreatives.id))
        .innerJoin(performanceLogs, eq(performanceLogs.adId, ads.id))
        .where(conditions.length > 0 ? sql`${sql.join(conditions, sql` AND `)}` : undefined)
        .groupBy(
          adCreatives.id,
          adCreatives.name,
          adCreatives.format,
          adCreatives.angle,
          adCreatives.persona,
          adCreatives.awarenessLevel,
          adCreatives.hook,
          adCreatives.tone,
          adCreatives.cta,
        )
        .orderBy(desc(sql`avg(${performanceLogs.roas})`))
        .limit(input.limit);

      if (topCreatives.length === 0) {
        return {
          brief: "Not enough performance data to generate a brief. Import more ads with performance metrics and tag your creatives first.",
          topPerformers: [],
          constraints: input,
        };
      }

      const performerSummary = topCreatives
        .map(
          (c, i) =>
            `${i + 1}. "${c.name}" — format: ${c.format || "?"}, angle: ${c.angle || "?"}, persona: ${c.persona || "?"}, awareness: ${c.awarenessLevel || "?"}, hook: ${c.hook || "?"}, tone: ${c.tone?.join(", ") || "?"}, CTA: ${c.cta || "?"}, avg ROAS: ${c.avgRoas || "?"}, avg CPA: $${c.avgCpa || "?"}`,
        )
        .join("\n");

      const { text } = await import("ai").then((m) =>
        m.generateText({
          model: openrouter("anthropic/claude-sonnet-4"),
          prompt: `You are a performance marketing strategist. Based on the top-performing ad creatives below, generate a creative brief for a new ad.

${input.format ? `Required format: ${input.format}` : ""}
${input.awarenessLevel ? `Target awareness level: ${input.awarenessLevel}` : ""}
${input.persona ? `Target persona: ${input.persona}` : ""}
${input.angle ? `Preferred angle: ${input.angle}` : ""}

Top performers:
${performerSummary}

Generate a creative brief that includes:
1. **Recommended Angle** — based on what's working
2. **Hook** — an opening line or visual hook
3. **Tone** — recommended tone(s)
4. **CTA** — call-to-action
5. **Key Messages** — 2-3 bullet points
6. **Landing Page Recommendations** — what the LP should emphasize
7. **Why This Should Work** — reasoning based on the performance data

Be specific and actionable. Reference the data to justify your recommendations.`,
        }),
      );

      return {
        brief: text,
        topPerformers: topCreatives.map((c) => ({
          name: c.name,
          format: c.format,
          angle: c.angle,
          avgRoas: c.avgRoas,
          avgCpa: c.avgCpa,
        })),
        constraints: input,
      };
    }),
});
