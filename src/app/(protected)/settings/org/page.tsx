"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Building2, Check, Copy } from "@/components/icons";
import { toast } from "sonner";

export default function OrganizationSettingsPage() {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const [copied, setCopied] = useState(false);

  async function copyOrganizationId() {
    if (!activeOrg?.id) return;

    try {
      await navigator.clipboard.writeText(activeOrg.id);
      setCopied(true);
      toast.success("Organization ID copied");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Failed to copy organization ID");
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Organization</h1>
        <p className="text-sm text-muted-foreground">
          View workspace identifiers used for integrations and scheduled jobs.
        </p>
      </div>

      <div className="rounded-lg border">
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Building2 className="size-4" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium">
              {activeOrg?.name ?? "Current organization"}
            </h2>
            <p className="text-xs text-muted-foreground">Active workspace</p>
          </div>
        </div>

        <div className="space-y-3 p-5">
          <div className="space-y-1.5">
            <label
              htmlFor="organization-id"
              className="text-xs font-medium text-muted-foreground"
            >
              Organization ID
            </label>
            <div className="flex gap-2">
              <Input
                id="organization-id"
                value={activeOrg?.id ?? ""}
                readOnly
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                onClick={copyOrganizationId}
                disabled={!activeOrg?.id}
              >
                {copied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
                Copy
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Use this value in{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
              ADSOLUTE_META_SYNC_ORGANIZATION_IDS
            </code>{" "}
            to enable Meta sync jobs for selected organizations.
          </p>
        </div>
      </div>
    </div>
  );
}
