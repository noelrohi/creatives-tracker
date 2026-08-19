"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Loader2 } from "@/components/icons";

const scopeDescriptions: Record<string, string> = {
  openid: "Confirm your identity",
  profile: "Read your name and profile",
  email: "Read your email address",
  offline_access: "Keep access without asking again",
};

function ConsentForm() {
  const searchParams = useSearchParams();
  const clientId = searchParams.get("client_id");
  const scopes = (searchParams.get("scope") ?? "").split(" ").filter(Boolean);

  const [clientName, setClientName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"accept" | "deny" | null>(null);

  useEffect(() => {
    if (!clientId) {
      return;
    }
    authClient.oauth2
      .publicClient({ query: { client_id: clientId } })
      .then(({ data }) => setClientName(data?.client_name ?? null))
      .catch(() => setClientName(null));
  }, [clientId]);

  async function decide(accept: boolean) {
    setSubmitting(accept ? "accept" : "deny");
    // oauthProviderClient attaches the signed OAuth query from the URL, which
    // identifies the in-flight authorization request being decided on.
    const { data, error } = await authClient.oauth2.consent({ accept });

    if (error || !data?.url) {
      toast.error(error?.message ?? "Failed to submit consent");
      setSubmitting(null);
      return;
    }

    window.location.assign(data.url);
  }

  if (!clientId) {
    return (
      <p className="text-sm text-muted-foreground">
        This page is only used while connecting an application. There is no
        authorization request to review.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-xl font-semibold tracking-tight">
          Authorize {clientName ?? "application"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {clientName ?? "An application"} wants to access your Adsolute
          account.
        </p>
      </div>

      {scopes.length > 0 && (
        <ul className="mb-8 flex flex-col gap-2">
          {scopes.map((scope) => (
            <li key={scope} className="flex items-start gap-2 text-sm">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/60" />
              {scopeDescriptions[scope] ?? scope}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3">
        <Button
          onClick={() => decide(true)}
          disabled={submitting !== null}
          className="w-full"
        >
          {submitting === "accept" && (
            <Loader2 className="size-4 animate-spin" />
          )}
          Approve
        </Button>
        <Button
          onClick={() => decide(false)}
          disabled={submitting !== null}
          variant="outline"
          className="w-full"
        >
          {submitting === "deny" && <Loader2 className="size-4 animate-spin" />}
          Deny
        </Button>
      </div>
    </div>
  );
}

export default function ConsentPage() {
  return (
    <Suspense>
      <ConsentForm />
    </Suspense>
  );
}
