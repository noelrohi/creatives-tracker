"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Search } from "lucide-react";

const FORMAT_OPTIONS = [
  { label: "Static", value: "static" },
  { label: "Video", value: "video" },
  { label: "UGC", value: "ugc" },
  { label: "Carousel", value: "carousel" },
] as const;

const AWARENESS_OPTIONS = [
  { label: "Unaware", value: "unaware" },
  { label: "Problem Aware", value: "problem_aware" },
  { label: "Solution Aware", value: "solution_aware" },
  { label: "Product Aware", value: "product_aware" },
  { label: "Most Aware", value: "most_aware" },
] as const;

export default function CreativesPage() {
  const trpc = useTRPC();
  type Format = "static" | "video" | "ugc" | "carousel";
  type Awareness = "unaware" | "problem_aware" | "solution_aware" | "product_aware" | "most_aware";

  const [format, setFormat] = useState<Format | undefined>(undefined);
  const [awarenessLevel, setAwarenessLevel] = useState<Awareness | undefined>(undefined);
  const [search, setSearch] = useState("");

  const creatives = useQuery(
    trpc.adCreative.list.queryOptions({
      format,
      awarenessLevel,
      search: search || undefined,
    }),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Creatives"
        description="Manage your ad creatives and their resolution tags."
      >
        <Button asChild>
          <Link href="/creatives/new">
            <Plus className="mr-2 size-4" /> New Creative
          </Link>
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search creatives..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 w-64"
          />
        </div>
        <Select
          value={format ?? "all"}
          onValueChange={(v) => setFormat(v === "all" ? undefined : v as Format)}
        >
          <SelectTrigger>
            <SelectValue placeholder="All Formats" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Formats</SelectItem>
            {FORMAT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={awarenessLevel ?? "all"}
          onValueChange={(v) => setAwarenessLevel(v === "all" ? undefined : v as Awareness)}
        >
          <SelectTrigger>
            <SelectValue placeholder="All Awareness Levels" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Awareness Levels</SelectItem>
            {AWARENESS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Format</TableHead>
              <TableHead>Angle</TableHead>
              <TableHead>Awareness Level</TableHead>
              <TableHead>Landing Page</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {creatives.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  No creatives found. Create your first one to get started.
                </TableCell>
              </TableRow>
            )}
            {creatives.data?.map((creative) => (
              <TableRow key={creative.id}>
                <TableCell>
                  <Link
                    href={`/creatives/${creative.id}`}
                    className="font-medium hover:underline"
                  >
                    {creative.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{creative.format}</Badge>
                </TableCell>
                <TableCell>{creative.angle}</TableCell>
                <TableCell>
                  <Badge variant="outline">{creative.awarenessLevel}</Badge>
                </TableCell>
                <TableCell>{creative.landingPageName ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
