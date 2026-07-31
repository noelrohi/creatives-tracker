/**
 * Shared by the `attribution` and `findings` routers: the store lookup every
 * read is scoped through, and the day-range input shape.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { DAY_PATTERN } from "@/lib/day";
import { getStoreForOrg } from "@/lib/attribution-queries";

/** `organizationId` always comes from ctx, never from the client. */
export async function requireStore(organizationId: string) {
  const store = await getStoreForOrg(organizationId);
  if (!store) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No Shopify store is connected for this organization",
    });
  }
  return store;
}

export const dateRangeShape = {
  dateFrom: z.string().regex(DAY_PATTERN, "Expected YYYY-MM-DD"),
  dateTo: z.string().regex(DAY_PATTERN, "Expected YYYY-MM-DD"),
};

export const orderedRange = {
  check: (value: { dateFrom: string; dateTo: string }) =>
    value.dateFrom <= value.dateTo,
  message: {
    message: "dateFrom must be on or before dateTo",
    path: ["dateFrom"],
  },
};

export const dateRangeSchema = z
  .object(dateRangeShape)
  .refine(orderedRange.check, orderedRange.message);
