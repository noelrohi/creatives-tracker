import { notFound } from "next/navigation";
import { isRecommendationsEnabled } from "@/lib/feature-flags";
import { RecommendationsPageClient } from "./recommendations-page-client";

export default function RecommendationsPage() {
  if (!isRecommendationsEnabled()) {
    notFound();
  }

  return <RecommendationsPageClient />;
}
