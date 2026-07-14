"use client";

import { Suspense, useMemo } from "react";
import { parseAsString, useQueryState } from "nuqs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  CirclePlus,
  ImageOff,
  Loader2,
  Search,
  Star,
} from "@/components/icons";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type GenerationSummary = RouterOutputs["studio"]["generations"][number];

const PREVIEW_LIMIT = 4;

function StatusBadge({ generation }: { generation: GenerationSummary }) {
  const ready = generation.variants.filter((v) => v.status === "ready").length;
  if (generation.status === "generating") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="size-3 animate-spin" />
        {ready} of {generation.count}
      </Badge>
    );
  }
  if (generation.status === "failed") {
    return (
      <Badge variant="outline" className="text-destructive">
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <CheckCircle2 className="size-3 text-primary" /> Ready
    </Badge>
  );
}

function PreviewCluster({ generation }: { generation: GenerationSummary }) {
  const shown = generation.variants.slice(0, PREVIEW_LIMIT);
  const extra = generation.variants.length - shown.length;

  return (
    <div className="flex items-center gap-1">
      {shown.map((variant) =>
        variant.status === "ready" && variant.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={variant.id}
            src={variant.imageUrl}
            alt=""
            className="aspect-[4/5] w-7 rounded border bg-muted object-cover"
          />
        ) : (
          <div
            key={variant.id}
            className="flex aspect-[4/5] w-7 items-center justify-center rounded border bg-muted text-muted-foreground"
          >
            {variant.status === "failed" ? (
              <ImageOff className="size-3" />
            ) : (
              <Loader2 className="size-3 animate-spin" />
            )}
          </div>
        ),
      )}
      {extra > 0 ? (
        <div className="flex aspect-[4/5] w-7 items-center justify-center rounded border bg-muted text-[10px] font-medium text-muted-foreground">
          +{extra}
        </div>
      ) : null}
    </div>
  );
}

function formatCreated(value: GenerationSummary["createdAt"]) {
  const date = new Date(value);
  const isToday = date.toDateString() === new Date().toDateString();
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function StudioLibraryContent() {
  const trpc = useTRPC();
  const router = useRouter();
  const [search, setSearch] = useQueryState("q", { defaultValue: "" });
  const [status, setStatus] = useQueryState("status", parseAsString.withDefault("all"));
  const [angle, setAngle] = useQueryState("angle", parseAsString.withDefault("all"));

  const { data, isLoading } = useQuery({
    ...trpc.studio.generations.queryOptions(),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((g) => g.status === "generating") ? 4000 : false,
  });

  const generations = useMemo(() => data ?? [], [data]);

  const angles = useMemo(() => {
    const unique = new Set<string>();
    for (const generation of generations) {
      if (generation.angle?.trim()) unique.add(generation.angle.trim());
    }
    return Array.from(unique).sort();
  }, [generations]);

  const stats = useMemo(() => {
    let images = 0;
    let starred = 0;
    for (const generation of generations) {
      for (const variant of generation.variants) {
        if (variant.status === "ready") images += 1;
        if (variant.starredAt) starred += 1;
      }
    }
    return { runs: generations.length, images, starred };
  }, [generations]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return generations.filter((generation) => {
      if (status !== "all") {
        const effective =
          generation.status === "generating" || generation.status === "failed"
            ? generation.status
            : "ready";
        if (effective !== status) return false;
      }
      if (angle !== "all" && generation.angle?.trim() !== angle) return false;
      if (
        query &&
        !generation.brief.toLowerCase().includes(query) &&
        !(generation.angle ?? "").toLowerCase().includes(query) &&
        !(generation.persona ?? "").toLowerCase().includes(query)
      ) {
        return false;
      }
      return true;
    });
  }, [generations, search, status, angle]);

  const hasFilters = search.trim() !== "" || status !== "all" || angle !== "all";

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col">
      <div className="flex items-center justify-between gap-3 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">
            Showing {stats.runs} recent {stats.runs === 1 ? "run" : "runs"} ·{" "}
            {stats.images} {stats.images === 1 ? "image" : "images"} ·{" "}
            {stats.starred} starred
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/studio">
            <CirclePlus className="size-4" /> New
          </Link>
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <InputGroup className="max-w-xs flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Search recent briefs…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </InputGroup>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm" className="w-[130px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="ready">Ready</SelectItem>
            <SelectItem value="generating">Generating</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
        {angles.length > 0 ? (
          <Select value={angle} onValueChange={setAngle}>
            <SelectTrigger size="sm" className="w-[150px]">
              <SelectValue placeholder="Angle" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All angles</SelectItem>
              {angles.map((value) => (
                <SelectItem key={value} value={value} className="capitalize">
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : generations.length === 0 ? (
        <Empty className="flex-none border py-10">
          <EmptyHeader>
            <EmptyTitle>No generations yet</EmptyTitle>
            <EmptyDescription>
              <Link href="/studio">Create your first</Link>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : filtered.length === 0 && hasFilters ? (
        <Empty className="flex-none border py-10">
          <EmptyHeader>
            <EmptyTitle>No runs match</EmptyTitle>
            <EmptyDescription>Try a different search or filter.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="mb-6 overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[150px]">Preview</TableHead>
                <TableHead>Brief</TableHead>
                <TableHead className="hidden sm:table-cell">Angle</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Starred</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((generation) => {
                const starred = generation.variants.filter(
                  (v) => v.starredAt,
                ).length;
                return (
                  <TableRow
                    key={generation.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/studio/${generation.id}`)}
                  >
                    <TableCell>
                      <PreviewCluster generation={generation} />
                    </TableCell>
                    <TableCell className="max-w-[220px]">
                      <Link
                        href={`/studio/${generation.id}`}
                        className="block truncate text-sm font-medium"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {generation.brief}
                      </Link>
                      {generation.source ? (
                        <p className="truncate text-xs text-muted-foreground">
                          ↳ {generation.source.name}
                          {generation.source.roas != null
                            ? ` · ${generation.source.roas.toFixed(1)}× ROAS`
                            : null}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden max-w-[140px] truncate capitalize text-muted-foreground sm:table-cell">
                      {generation.angle ?? "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge generation={generation} />
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">
                      {starred > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <Star className="size-3" /> {starred}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatCreated(generation.createdAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default function StudioLibraryPage() {
  return (
    <Suspense>
      <StudioLibraryContent />
    </Suspense>
  );
}
