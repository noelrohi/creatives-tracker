"use client";

import Link from "next/link";
import { ArrowLeft } from "@/components/icons";
import { ADVISORY_BANNER } from "./copy";

/**
 * Query/mutation orchestration shell for the Klaviyo Lab. Panels attach
 * here view by view; this shell owns only navigation and the advisory
 * banner.
 */
export function KlaviyoPlayground() {
  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-3">
        <Link
          href="/attribution"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Attribution
        </Link>
      </div>
      <div>
        <h1 className="text-xl font-semibold">Klaviyo Lab</h1>
        <p className="text-sm text-muted-foreground">{ADVISORY_BANNER}</p>
      </div>
    </div>
  );
}
