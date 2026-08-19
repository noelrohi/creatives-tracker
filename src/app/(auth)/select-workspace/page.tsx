"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { listOrganizations } from "@/lib/organization-client";
import { Button } from "@/components/ui/button";
import { Loader2 } from "@/components/icons";

type Workspace = { id: string; name: string; slug: string };

function SelectWorkspaceForm() {
  const searchParams = useSearchParams();
  const clientId = searchParams.get("client_id");

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  useEffect(() => {
    listOrganizations()
      .then(setWorkspaces)
      .catch(() => {
        toast.error("Failed to load workspaces");
        setWorkspaces([]);
      });
  }, []);

  async function choose(workspace: Workspace) {
    setSubmittingId(workspace.id);

    const { error: setActiveError } = await authClient.organization.setActive({
      organizationId: workspace.id,
    });
    if (setActiveError) {
      toast.error(setActiveError.message ?? "Failed to select workspace");
      setSubmittingId(null);
      return;
    }

    // oauthProviderClient attaches the signed OAuth query from the URL;
    // continue resumes the authorization with the selection recorded.
    const { data, error } = await authClient.oauth2.continue({
      postLogin: true,
    });
    if (error || !data?.url) {
      toast.error(error?.message ?? "Failed to continue authorization");
      setSubmittingId(null);
      return;
    }

    window.location.assign(data.url);
  }

  if (!clientId) {
    return (
      <p className="text-sm text-muted-foreground">
        This page is only used while connecting an application. There is no
        authorization request to continue.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-xl font-semibold tracking-tight">
          Choose a workspace
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The application you are connecting will only see data from the
          workspace you pick.
        </p>
      </div>

      {workspaces === null ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : workspaces.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You are not a member of any workspace yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {workspaces.map((workspace) => (
            <Button
              key={workspace.id}
              onClick={() => choose(workspace)}
              disabled={submittingId !== null}
              variant="outline"
              className="w-full justify-start"
            >
              {submittingId === workspace.id && (
                <Loader2 className="size-4 animate-spin" />
              )}
              {workspace.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SelectWorkspacePage() {
  return (
    <Suspense>
      <SelectWorkspaceForm />
    </Suspense>
  );
}
