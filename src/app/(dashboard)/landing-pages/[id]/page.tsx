"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Plus, Pencil, Check, X } from "lucide-react";

export default function LandingPageDetailPage() {
  const { id } = useParams<{ id: string }>();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(
    trpc.landingPage.getById.queryOptions({ id }),
  );

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");

  const updateMutation = useMutation({
    ...trpc.landingPage.update.mutationOptions(),
    onSuccess: () => {
      toast.success("Landing page updated");
      setEditing(false);
      queryClient.invalidateQueries(
        trpc.landingPage.getById.queryOptions({ id }),
      );
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const startEditing = () => {
    if (data) {
      setEditName(data.name);
      setEditUrl(data.url);
      setEditing(true);
    }
  };

  const handleSave = () => {
    updateMutation.mutate({ id, name: editName, url: editUrl });
  };

  const handleCancel = () => {
    setEditing(false);
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-9 w-20" />
        </div>
        <Card><CardContent className="pt-6">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-64" />
          </div>
        </CardContent></Card>
        <Skeleton className="h-6 w-24" />
        <div className="rounded-md border p-4 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Landing page not found" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={data.name}
        description="Landing page details and versions."
      >
        {!editing && (
          <Button variant="outline" size="sm" onClick={startEditing}>
            <Pencil className="mr-2 size-4" /> Edit
          </Button>
        )}
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent>
          {editing ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-url">URL</Label>
                <Input
                  id="edit-url"
                  type="url"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                >
                  <Check className="mr-2 size-4" />
                  {updateMutation.isPending ? "Saving..." : "Save"}
                </Button>
                <Button size="sm" variant="outline" onClick={handleCancel}>
                  <X className="mr-2 size-4" /> Cancel
                </Button>
              </div>
            </div>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="font-medium text-muted-foreground">Name</dt>
              <dd>{data.name}</dd>
              <dt className="font-medium text-muted-foreground">URL</dt>
              <dd>
                <a
                  href={data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {data.url}
                </a>
              </dd>
            </dl>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Versions</h2>
        <Button asChild size="sm">
          <Link href={`/landing-pages/${id}/versions/new`}>
            <Plus className="mr-2 size-4" /> Add Version
          </Link>
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version #</TableHead>
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
                  No versions yet. Add your first version.
                </TableCell>
              </TableRow>
            ) : (
              data.versions.map((version) => (
                <TableRow key={version.id}>
                  <TableCell className="font-medium">
                    v{version.version}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {version.pageType.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate">
                    {version.heroCopy}
                  </TableCell>
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
