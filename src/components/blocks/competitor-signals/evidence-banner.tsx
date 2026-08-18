"use client";

import { useSyncExternalStore } from "react";
import { Info, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EVIDENCE_NOTE } from "./copy";

const DISMISS_KEY = "competitor-signals:evidence-banner-dismissed";

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isDismissed() {
  return sessionStorage.getItem(DISMISS_KEY) === "1";
}

/** The server has no sessionStorage: render dismissed, then settle on mount. */
function isDismissedOnServer() {
  return true;
}

function dismiss() {
  sessionStorage.setItem(DISMISS_KEY, "1");
  for (const listener of listeners) listener();
}

/**
 * The honesty guardrail (§10), dismissable per session — sessionStorage, so it
 * comes back on the next visit rather than being silenced for good.
 */
export function EvidenceBanner() {
  const dismissed = useSyncExternalStore(
    subscribe,
    isDismissed,
    isDismissedOnServer,
  );

  if (dismissed) return null;

  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-[13px] text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0 opacity-60" />
      <p className="flex-1">{EVIDENCE_NOTE}</p>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={dismiss}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
