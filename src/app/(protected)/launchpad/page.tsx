import { notFound } from "next/navigation";
import { isLaunchpadEnabled } from "@/lib/feature-flags";
import { LaunchpadPageClient } from "./launchpad-page-client";

export default function LaunchpadPage() {
  if (!isLaunchpadEnabled()) {
    notFound();
  }

  return <LaunchpadPageClient />;
}
