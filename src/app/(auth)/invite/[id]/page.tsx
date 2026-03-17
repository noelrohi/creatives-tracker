"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { organization, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import Link from "next/link";

export default function InvitePage() {
  const params = useParams();
  const router = useRouter();
  const { data: session, isPending: sessionLoading } = useSession();
  const invitationId = params.id as string;

  const [status, setStatus] = useState<"loading" | "accepting" | "success" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (sessionLoading) return;

    if (!session) {
      // Not signed in — redirect to sign-in, then back here
      router.push(`/sign-in?redirect=/invite/${invitationId}`);
      return;
    }

    setStatus("accepting");
    organization
      .acceptInvitation({ invitationId })
      .then(async (result) => {
        if (result.error) {
          setStatus("error");
          setErrorMessage(result.error.message ?? "Failed to accept invitation");
          return;
        }

        // Set the org as active
        if (result.data?.member?.organizationId) {
          await organization.setActive({
            organizationId: result.data.member.organizationId,
          });
        }

        setStatus("success");
        // Redirect after brief delay
        setTimeout(() => {
          window.location.href = "/";
        }, 1500);
      })
      .catch(() => {
        setStatus("error");
        setErrorMessage("Something went wrong");
      });
  }, [session, sessionLoading, invitationId, router]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>Workspace Invitation</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          {(status === "loading" || status === "accepting") && (
            <>
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {status === "loading" ? "Checking session..." : "Accepting invitation..."}
              </p>
            </>
          )}

          {status === "success" && (
            <>
              <CheckCircle className="size-8 text-emerald-500" />
              <p className="text-sm text-muted-foreground">
                Invitation accepted! Redirecting...
              </p>
            </>
          )}

          {status === "error" && (
            <>
              <XCircle className="size-8 text-destructive" />
              <p className="text-sm text-muted-foreground">{errorMessage}</p>
              <Button variant="outline" size="sm" asChild>
                <Link href="/">Go to dashboard</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
