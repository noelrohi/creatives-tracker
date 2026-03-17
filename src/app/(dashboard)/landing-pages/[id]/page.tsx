"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EditableText } from "@/components/editable-field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";

export default function LandingPageDetailPage() {
  const trpc = useTRPC();
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const [savingField, setSavingField] = useState<string | null>(null);

  const landingPage = useQuery(trpc.landingPage.getById.queryOptions({ id }));

  const updateMutation = useMutation({
    ...trpc.landingPage.update.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.landingPage.getById.queryKey({ id }) });
      queryClient.invalidateQueries({ queryKey: trpc.landingPage.list.queryKey() });
      setSavingField(null);
    },
    onError: (error) => {
      toast.error(error.message);
      setSavingField(null);
    },
  });

  const deleteMutation = useMutation({
    ...trpc.landingPage.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.landingPage.list.queryKey() });
      toast.success("Landing page deleted");
      router.push("/landing-pages");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete landing page");
    },
  });

  const saveField = (field: string, value: unknown) => {
    setSavingField(field);
    updateMutation.mutate({ id, [field]: value });
  };

  const handleDelete = () => {
    deleteMutation.mutate({ id });
  };

  if (landingPage.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8" />
            <Skeleton className="h-8 w-64" />
          </div>
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="rounded-lg border p-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="grid grid-cols-[140px_1fr] items-center gap-3 px-3 py-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (landingPage.isError || !landingPage.data) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <p className="text-muted-foreground">Landing page not found.</p>
        <Button variant="outline" asChild>
          <Link href="/landing-pages">Back to Landing Pages</Link>
        </Button>
      </div>
    );
  }

  const data = landingPage.data;

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/landing-pages">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <EditableTitle
            value={data.name}
            onSave={(v) => saveField("name", v)}
            saving={savingField === "name"}
          />
        </div>
        <ConfirmDialog
          title="Delete landing page"
          description="This will permanently delete this landing page and all its versions."
          confirmLabel="Delete"
          onConfirm={handleDelete}
          loading={deleteMutation.isPending}
          trigger={
            <Button variant="ghost" size="sm" className="text-muted-foreground/50 hover:text-destructive">
              <Trash2 className="mr-1.5 size-3.5" /> Delete
            </Button>
          }
        />
      </div>

      {/* Fields */}
      <div className="rounded-lg border divide-y">
        <EditableText
          label="URL"
          value={data.url}
          onSave={(v) => saveField("url", v)}
          type="url"
          placeholder="https://..."
          saving={savingField === "url"}
        />
      </div>

      {/* Metadata */}
      <p className="text-xs text-muted-foreground px-3">
        Created {new Date(data.createdAt).toLocaleDateString()} · Last updated{" "}
        {new Date(data.updatedAt).toLocaleDateString()}
      </p>

      {/* Versions */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Versions</h2>
        <Button size="sm" asChild>
          <Link href={`/landing-pages/${id}/versions/new`}>
            <Plus className="mr-2 size-4" /> Add Version
          </Link>
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Page Type</TableHead>
              <TableHead>Hero Copy</TableHead>
              <TableHead>Funnel Position</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.versions.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground"
                >
                  No versions yet. Add the first version.
                </TableCell>
              </TableRow>
            ) : (
              data.versions.map((version) => (
                <TableRow key={version.id}>
                  <TableCell className="font-medium">v{version.version}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {version.pageType.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate">{version.heroCopy}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {version.funnelPosition.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(version.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function EditableTitle({
  value,
  onSave,
  saving,
}: {
  value: string | null | undefined;
  onSave: (value: string) => void;
  saving?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  const handleSave = () => {
    setEditing(false);
    if (draft !== (value ?? "")) {
      onSave(draft);
    }
  };

  return editing ? (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={handleSave}
      onKeyDown={(e) => {
        if (e.key === "Enter") handleSave();
        if (e.key === "Escape") {
          setDraft(value ?? "");
          setEditing(false);
        }
      }}
      className="bg-transparent text-2xl font-semibold tracking-tight outline-none border-b-2 border-primary"
    />
  ) : (
    <button
      type="button"
      onClick={() => {
        setDraft(value ?? "");
        setEditing(true);
      }}
      className="flex items-center gap-2 text-2xl font-semibold tracking-tight hover:text-muted-foreground transition-colors"
    >
      {value || "Untitled Landing Page"}
      {saving && (
        <span className="text-xs font-normal text-muted-foreground">Saving...</span>
      )}
    </button>
  );
}
