import { router } from "../init";
import { landingPageRouter } from "./landing-page";
import { adCreativeRouter } from "./ad-creative";
import { campaignConfigRouter } from "./campaign-config";
import { adSetRouter } from "./ad-set";
import { performanceLogRouter } from "./performance-log";
import { tagRouter } from "./tag";
import { abTestRouter } from "./ab-test";

export const appRouter = router({
  landingPage: landingPageRouter,
  adCreative: adCreativeRouter,
  campaignConfig: campaignConfigRouter,
  adSet: adSetRouter,
  performanceLog: performanceLogRouter,
  tag: tagRouter,
  abTest: abTestRouter,
});

export type AppRouter = typeof appRouter;
