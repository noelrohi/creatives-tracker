import { router } from "../init";
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
import { teamRouter } from "./team";
import { managerRouter } from "./manager";
import { metaSyncRouter } from "./meta-sync";
import { triggerRouter } from "./trigger";
import { studioRouter } from "./studio";
import { attributionRouter } from "./attribution";
import { findingsRouter } from "./findings";
import { landingPageRouter } from "./landing-page";

export const appRouter = router({
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
  team: teamRouter,
  manager: managerRouter,
  metaSync: metaSyncRouter,
  trigger: triggerRouter,
  studio: studioRouter,
  attribution: attributionRouter,
  findings: findingsRouter,
  landingPage: landingPageRouter,
});

export type AppRouter = typeof appRouter;
