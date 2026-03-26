import { router } from "../init";
import { landingPageRouter } from "./landing-page";
import { adCreativeRouter } from "./ad-creative";
import { campaignRouter } from "./campaign";
import { adSetRouter } from "./ad-set";
import { adRouter } from "./ad";
import { performanceLogRouter } from "./performance-log";
import { tagRouter } from "./tag";
import { abTestRouter } from "./ab-test";
import { adAccountRouter } from "./account";
import { metaInsightsRouter } from "./meta-insights";
import { apiKeyRouter } from "./api-key";
import { organizationRouter } from "./organization";

export const appRouter = router({
  landingPage: landingPageRouter,
  adCreative: adCreativeRouter,
  campaign: campaignRouter,
  adSet: adSetRouter,
  ad: adRouter,
  performanceLog: performanceLogRouter,
  tag: tagRouter,
  abTest: abTestRouter,
  adAccount: adAccountRouter,
  metaInsights: metaInsightsRouter,
  apiKey: apiKeyRouter,
  organization: organizationRouter,
});

export type AppRouter = typeof appRouter;
