"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { activateFirstOrganization } from "@/lib/organization-client";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type DeleteOrganizationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organization: {
    id: string;
    name: string;
  } | null;
};

export function DeleteOrganizationDialog({
  open,
  onOpenChange,
  organization,
}: DeleteOrganizationDialogProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [confirmationName, setConfirmationName] = useState("");

  const deleteMutation = useMutation(trpc.organization.delete.mutationOptions());

  const isMatch = confirmationName === organization?.name;

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setConfirmationName("");
    }

    onOpenChange(nextOpen);
  }

  async function handleDelete() {
    if (!organization || !isMatch) {
      return;
    }

    try {
      await deleteMutation.mutateAsync({ organizationId: organization.id });
      const { organizations } = await activateFirstOrganization();

      queryClient.clear();
      setConfirmationName("");
      onOpenChange(false);
      toast.success(`Deleted ${organization.name}`);

      if (organizations.length === 0) {
        router.replace("/create-organization");
      }

      router.refresh();
    } catch (error) {
      toast.error(
        getUserFacingErrorMessage(error, "Failed to delete workspace."),
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete workspace</DialogTitle>
          <DialogDescription>
            This permanently deletes the workspace, its members&apos; access,
            and all associated campaigns, creatives, imports,
            logs, tags, and API keys.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-4 text-destructive" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">This action is irreversible.</p>
              <p className="text-muted-foreground">
                Type <span className="font-medium text-foreground">{organization?.name}</span>{" "}
                to confirm.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="delete-organization-confirmation">
            Workspace name
          </Label>
          <Input
            id="delete-organization-confirmation"
            value={confirmationName}
            onChange={(event) => setConfirmationName(event.target.value)}
            placeholder={organization?.name ?? "Workspace name"}
            autoFocus
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={deleteMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDelete}
            disabled={!isMatch || deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <>
                <Loader2 className="animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete workspace"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
