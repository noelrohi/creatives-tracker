"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, Sparkles, Copy, Check } from "lucide-react";
import { toast } from "sonner";

const FORMATS = ["static", "video", "ugc", "carousel"] as const;
const AWARENESS = [
  "unaware",
  "problem_aware",
  "solution_aware",
  "product_aware",
  "most_aware",
] as const;

export default function BriefsPage() {
  const trpc = useTRPC();
  const [format, setFormat] = useState<string>("");
  const [awareness, setAwareness] = useState<string>("");
  const [persona, setPersona] = useState("");
  const [angle, setAngle] = useState("");
  const [copied, setCopied] = useState(false);

  const generateMutation = useMutation(
    trpc.ai.generateBrief.mutationOptions({
      onError: (error) => toast.error(error.message || "Generation failed"),
    }),
  );

  function handleGenerate() {
    generateMutation.mutate({
      format: format ? (format as (typeof FORMATS)[number]) : undefined,
      awarenessLevel: awareness ? (awareness as (typeof AWARENESS)[number]) : undefined,
      persona: persona || undefined,
      angle: angle || undefined,
      limit: 5,
    });
  }

  function handleCopy() {
    if (generateMutation.data?.brief) {
      navigator.clipboard.writeText(generateMutation.data.brief);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Brief copied to clipboard");
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-lg font-semibold">Brief Generator</h1>
        <p className="text-sm text-muted-foreground">
          Generate creative briefs based on your top-performing ads.
        </p>
      </div>

      {/* Constraint selectors */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="mb-1 block text-[13px] text-muted-foreground">
            Format
          </label>
          <Select value={format} onValueChange={setFormat}>
            <SelectTrigger>
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any_format">Any</SelectItem>
              {FORMATS.map((f) => (
                <SelectItem key={f} value={f} className="capitalize">
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-[13px] text-muted-foreground">
            Awareness Level
          </label>
          <Select value={awareness} onValueChange={setAwareness}>
            <SelectTrigger>
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any_awareness">Any</SelectItem>
              {AWARENESS.map((a) => (
                <SelectItem key={a} value={a} className="capitalize">
                  {a.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-[13px] text-muted-foreground">
            Persona
          </label>
          <input
            type="text"
            placeholder="e.g. stressed professional"
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label className="mb-1 block text-[13px] text-muted-foreground">
            Angle
          </label>
          <input
            type="text"
            placeholder="e.g. teeth grinding"
            value={angle}
            onChange={(e) => setAngle(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      </div>

      <Button
        onClick={handleGenerate}
        disabled={generateMutation.isPending}
        className="w-fit gap-1.5"
      >
        <Sparkles className="size-3.5" />
        {generateMutation.isPending ? "Generating..." : "Generate Brief"}
      </Button>

      {/* Loading state */}
      {generateMutation.isPending && (
        <div className="space-y-3 rounded-lg border border-border p-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      )}

      {/* Result */}
      {generateMutation.data && !generateMutation.isPending && (
        <div className="space-y-4">
          {/* Top performers used */}
          {generateMutation.data.topPerformers.length > 0 && (
            <div>
              <h3 className="mb-2 text-[13px] font-medium uppercase tracking-wider text-muted-foreground/50">
                Based on top performers
              </h3>
              <div className="flex flex-wrap gap-2">
                {generateMutation.data.topPerformers.map((p) => (
                  <Badge key={p.name} variant="secondary" className="text-[11px]">
                    {p.name}
                    {p.avgRoas && ` · ${parseFloat(p.avgRoas).toFixed(1)}x ROAS`}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Brief content */}
          <div className="relative rounded-lg border border-border p-6">
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute right-3 top-3"
              onClick={handleCopy}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
            <div className="prose prose-sm max-w-none dark:prose-invert whitespace-pre-wrap text-sm leading-relaxed">
              {generateMutation.data.brief}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
