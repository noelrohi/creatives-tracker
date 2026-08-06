"use client";

import { Button } from "@/components/ui/button";

export default function KlaviyoError({ reset }: { reset: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 p-6">
      <h2 className="text-lg font-semibold">Klaviyo Lab could not load</h2>
      <p className="text-sm text-muted-foreground">
        Previously synced evidence is unchanged. Production attribution is not
        affected.
      </p>
      <Button variant="outline" onClick={() => reset()}>
        Retry
      </Button>
    </div>
  );
}
