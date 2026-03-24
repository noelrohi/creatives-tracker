import { router } from "../init";
import { landingPageRouter } from "./landing-page";
import { adCreativeRouter } from "./ad-creative";
import { campaignRouter } from "./campaign";
import { adSetRouter } from "./ad-set";
import { adRouter } from "./ad";
import { performanceLogRouter } from "./performance-log";
import { tagRouter } from "./tag";
import { abTestRouter } from "./ab-test";
import { accountRouter } from "./account";

export const appRouter = router({
  landingPage: landingPageRouter,
  adCreative: adCreativeRouter,
  campaign: campaignRouter,
  adSet: adSetRouter,
  ad: adRouter,
  performanceLog: performanceLogRouter,
  tag: tagRouter,
  abTest: abTestRouter,
  account: accountRouter,
});

export type AppRouter = typeof appRouter;
