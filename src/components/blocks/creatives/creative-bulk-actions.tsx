"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, UserCheck } from "@/components/icons";
import { useTRPC } from "@/lib/trpc/client";

export function CreativeBulkActions({
  selectedIds,
  teams,
  onComplete,
}: {
  selectedIds: string[];
  teams: { id: string; name: string }[];
  onComplete: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [teamDialogOpen, setTeamDialogOpen] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState("");

  const invalidateCreatives = () =>
    queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });

  const deleteMutation = useMutation({
    ...trpc.adCreative.delete.mutationOptions(),
    onSuccess: invalidateCreatives,
  });
  const teamMutation = useMutation({
    ...trpc.adCreative.bulkUpdateTeam.mutationOptions(),
    onSuccess: invalidateCreatives,
  });

  const handleDelete = async () => {
    try {
      await Promise.all(selectedIds.map((id) => deleteMutation.mutateAsync({ id })));
      toast.success(`Deleted ${selectedIds.length} creative${selectedIds.length === 1 ? "" : "s"}`);
      setDeleteOpen(false);
      onComplete();
    } catch {
      toast.error("Failed to delete some creatives");
    }
  };

  const handleUpdateTeam = async () => {
    try {
      await teamMutation.mutateAsync({
        ids: selectedIds,
        teamId: selectedTeam === "none" ? null : selectedTeam,
      });
      toast.success(`Updated team for ${selectedIds.length} creative${selectedIds.length === 1 ? "" : "s"}`);
      setTeamDialogOpen(false);
      setSelectedTeam("");
      onComplete();
    } catch {
      toast.error("Failed to update team");
    }
  };

  if (selectedIds.length === 0) return null;

  return (
    <>
      <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-2.5 shadow-lg">
          <span className="text-sm font-medium">{selectedIds.length} selected</span>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setTeamDialogOpen(true)}>
            <UserCheck className="size-3.5" /> Update Team
          </Button>
          <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="size-3.5" /> Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={onComplete}>Cancel</Button>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${selectedIds.length} creative${selectedIds.length === 1 ? "" : "s"}`}
        description={`This will permanently delete ${selectedIds.length} creative${selectedIds.length === 1 ? "" : "s"}. This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        loading={deleteMutation.isPending}
      />

      <Dialog open={teamDialogOpen} onOpenChange={setTeamDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Update Team</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Assign {selectedIds.length} creative{selectedIds.length === 1 ? "" : "s"} to a team.
          </p>
          <Select value={selectedTeam} onValueChange={setSelectedTeam}>
            <SelectTrigger><SelectValue placeholder="Select a team" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setTeamDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleUpdateTeam} disabled={!selectedTeam || teamMutation.isPending}>
              {teamMutation.isPending ? "Updating..." : "Update"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
