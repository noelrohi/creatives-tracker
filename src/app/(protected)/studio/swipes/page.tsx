"use client";
/* eslint-disable @next/next/no-img-element */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseAsArrayOf, parseAsString, useQueryState } from "nuqs";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  ImagePlus,
  Loader2,
  Plus,
  Settings,
  Trash2,
  X,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { buildRebrandBrief } from "@/lib/studio-prompt";
import { useTRPC, type RouterOutputs } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { StudioCreateDialog, type StudioDialogValue } from "../studio-create-dialog";

type Swipe = RouterOutputs["studio"]["swipes"][number];
type TaxonomyValue = RouterOutputs["studio"]["taxonomies"][number];
type PastedSwipe = {
  tempId: string;
  file: File;
  previewUrl: string;
  status: "uploading" | "failed" | "saved";
  swipe?: Swipe;
  brandName: string;
  angleId: string;
  hookTypeId: string;
  tagOpen: boolean;
};

async function sha256(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function FilterChips({
  values,
  selected,
  onToggle,
}: {
  values: TaxonomyValue[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.filter((value) => !value.archivedAt).map((value) => (
        <button key={value.id} type="button" onClick={() => onToggle(value.id)}>
          <Badge variant={selected.includes(value.id) ? "default" : "outline"} className="cursor-pointer text-[11px]">
            {value.name}
          </Badge>
        </button>
      ))}
    </div>
  );
}

function AddSwipeDialog({
  taxonomy,
  onSaved,
}: {
  taxonomy: TaxonomyValue[];
  onSaved: () => void;
}) {
  const trpc = useTRPC();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [brandName, setBrandName] = useState("");
  const [angleId, setAngleId] = useState("none");
  const [styleId, setStyleId] = useState("none");
  const [why, setWhy] = useState("");
  const [uploading, setUploading] = useState(false);
  const create = useMutation(
    trpc.studio.createSwipe.mutationOptions({
      onSuccess: ({ duplicate, swipe }) => {
        if (duplicate) {
          toast.warning(
            `That source URL is already saved${swipe.brandName ? ` as ${swipe.brandName}` : ""}.`,
          );
        } else {
          toast.success("Swipe saved");
        }
        setOpen(false);
        onSaved();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  async function upload(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Choose an image screenshot.");
      return;
    }
    setPreviewUrl(URL.createObjectURL(file));
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/upload", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!response.ok || !body?.url) throw new Error(body?.error || "Upload failed");
      setImageUrl(body.url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
      setPreviewUrl("");
    } finally {
      setUploading(false);
    }
  }

  const angles = taxonomy.filter((value) => value.kind === "angle" && !value.archivedAt);
  const styles = taxonomy.filter((value) => value.kind === "visual_style" && !value.archivedAt);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button className="h-9"><ImagePlus /> Add swipe</Button></DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a swipe</DialogTitle>
          <DialogDescription>Upload the screenshot now. The saved asset is ours even if the source link expires.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
          <button type="button" className="flex aspect-[4/5] items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/40 text-sm text-muted-foreground" onClick={() => fileRef.current?.click()}>
            {previewUrl ? (
              <img src={previewUrl} alt="Swipe preview" className="size-full object-cover" />
            ) : uploading ? <Loader2 className="animate-spin" /> : <span className="flex flex-col items-center gap-2"><ImagePlus /> Upload screenshot</span>}
          </button>
          <input ref={fileRef} hidden type="file" accept="image/*" onChange={(event) => void upload(event.target.files?.[0])} />
          <div className="space-y-3">
            <Input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="Source URL (optional)" />
            <Input value={brandName} onChange={(event) => setBrandName(event.target.value)} placeholder="Brand name (optional)" />
            <div className="grid grid-cols-2 gap-2">
              <Select value={angleId} onValueChange={setAngleId}><SelectTrigger><SelectValue placeholder="Angle" /></SelectTrigger><SelectContent><SelectItem value="none">No angle</SelectItem>{angles.map((value) => <SelectItem key={value.id} value={value.id}>{value.name}</SelectItem>)}</SelectContent></Select>
              <Select value={styleId} onValueChange={setStyleId}><SelectTrigger><SelectValue placeholder="Visual style" /></SelectTrigger><SelectContent><SelectItem value="none">No visual style</SelectItem>{styles.map((value) => <SelectItem key={value.id} value={value.id}>{value.name}</SelectItem>)}</SelectContent></Select>
            </div>
            <Textarea value={why} onChange={(event) => setWhy(event.target.value)} placeholder="Why it works (optional)" className="min-h-24" />
          </div>
        </div>
        <DialogFooter>
          <Button disabled={!imageUrl || uploading || create.isPending} onClick={() => create.mutate({ imageUrl, sourceUrl, brandName, angleId: angleId === "none" ? undefined : angleId, visualStyleId: styleId === "none" ? undefined : styleId, whyItWorks: why })}>
            {create.isPending ? <Loader2 className="animate-spin" /> : <Check />} Save swipe
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TaxonomyManager({ values, onChanged }: { values: TaxonomyValue[]; onChanged: () => void }) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"angle" | "visual_style" | "hook_type">("angle");
  const [name, setName] = useState("");
  const add = useMutation(trpc.studio.addTaxonomyValue.mutationOptions({ onSuccess: () => { setName(""); onChanged(); }, onError: (error) => toast.error(error.message) }));
  const archive = useMutation(trpc.studio.archiveTaxonomyValue.mutationOptions({ onSuccess: onChanged, onError: (error) => toast.error(error.message) }));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Settings /> Manage tags</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Studio taxonomy tags</DialogTitle><DialogDescription>Add workspace vocabulary or archive values to hide them from pickers.</DialogDescription></DialogHeader>
        <div className="flex gap-2"><Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="angle">Angle</SelectItem><SelectItem value="visual_style">Visual style</SelectItem><SelectItem value="hook_type">Hook type</SelectItem></SelectContent></Select><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Plain-language value" /><Button disabled={!name.trim() || add.isPending} onClick={() => add.mutate({ kind, name })}><Plus /> Add</Button></div>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2">
          {values.map((value) => <div key={value.id} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm", value.archivedAt && "opacity-50")}><Badge variant="outline" className="w-20 justify-center text-[10px]">{value.kind === "angle" ? "Angle" : value.kind === "hook_type" ? "Hook" : "Style"}</Badge><span className="flex-1">{value.name}</span><Button size="sm" variant="ghost" className="h-7" onClick={() => archive.mutate({ id: value.id, archived: !value.archivedAt })}>{value.archivedAt ? "Restore" : "Archive"}</Button></div>)}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CopyPackageManager({ taxonomy }: { taxonomy: TaxonomyValue[] }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const packages = useQuery(trpc.studio.copyPackages.queryOptions());
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [angleId, setAngleId] = useState("none");
  const [primaryText, setPrimaryText] = useState("");
  const [headline, setHeadline] = useState("");
  const [description, setDescription] = useState("");
  const reset = () => {
    setEditingId(null);
    setName("");
    setAngleId("none");
    setPrimaryText("");
    setHeadline("");
    setDescription("");
  };
  const changed = () => {
    reset();
    void client.invalidateQueries({ queryKey: trpc.studio.copyPackages.queryKey() });
  };
  const create = useMutation(trpc.studio.createCopyPackage.mutationOptions({
    onSuccess: () => { toast.success("Copy package saved"); changed(); },
    onError: (error) => toast.error(error.message),
  }));
  const update = useMutation(trpc.studio.updateCopyPackage.mutationOptions({
    onSuccess: changed,
    onError: (error) => toast.error(error.message),
  }));
  const angles = taxonomy.filter((value) => value.kind === "angle" && !value.archivedAt);
  const save = () => {
    const values = {
      name,
      angleId: angleId === "none" ? null : angleId,
      primaryText,
      headline,
      description,
    };
    if (editingId) update.mutate({ id: editingId, ...values });
    else create.mutate(values);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">Copy packages</Button></DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>Copy packages</DialogTitle><DialogDescription>Curate the full Meta trio: primary text, headline, and description.</DialogDescription></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Input placeholder="Package name" value={name} onChange={(event) => setName(event.target.value)} />
            <Select value={angleId} onValueChange={setAngleId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No angle</SelectItem>{angles.map((value) => <SelectItem key={value.id} value={value.id}>{value.name}</SelectItem>)}</SelectContent></Select>
            <Textarea placeholder="Primary text" value={primaryText} onChange={(event) => setPrimaryText(event.target.value)} />
            <Input placeholder="Headline" value={headline} onChange={(event) => setHeadline(event.target.value)} />
            <Input placeholder="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
            <div className="flex gap-2">
              {editingId ? <Button variant="outline" onClick={reset}>Cancel</Button> : null}
              <Button className="flex-1" disabled={!name.trim() || !primaryText.trim() || !headline.trim() || create.isPending || update.isPending} onClick={save}><Plus /> {editingId ? "Save changes" : "Add package"}</Button>
            </div>
          </div>
          <div className="max-h-96 space-y-2 overflow-y-auto">{packages.data?.map((pkg) => <div key={pkg.id} className="rounded-lg border p-3"><div className="flex items-start justify-between gap-2"><div><p className="text-sm font-medium">{pkg.name}</p><p className="line-clamp-2 text-xs text-muted-foreground">{pkg.primaryText}</p></div><div className="flex"><Button size="sm" variant="ghost" className="h-7" onClick={() => { setEditingId(pkg.id); setName(pkg.name); setAngleId(pkg.angleId ?? "none"); setPrimaryText(pkg.primaryText); setHeadline(pkg.headline); setDescription(pkg.description); }}>Edit</Button><Button size="sm" variant="ghost" className="h-7" onClick={() => update.mutate({ id: pkg.id, archived: true })}>Archive</Button></div></div></div>)}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SwipeBoard({ swipes, pasted, angles, hooks, suggestedHooks, onUse, onArchive, onDelete, onRetry, onChangePasted, onFinishTagging }: { swipes: Swipe[]; pasted: PastedSwipe[]; angles: TaxonomyValue[]; hooks: TaxonomyValue[]; suggestedHooks: Map<string, string | null>; onUse: (swipe: Swipe) => void; onArchive: (id: string) => void; onDelete: (id: string) => void; onRetry: (item: PastedSwipe) => void; onChangePasted: (tempId: string, values: Partial<PastedSwipe>) => void; onFinishTagging: (item: PastedSwipe, save: boolean) => void }) {
  const pastedIds = new Set(pasted.flatMap((item) => item.swipe ? [item.swipe.id] : []));
  return <div className="columns-2 gap-4 sm:columns-3 lg:columns-4 [&>*]:mb-4">
    {pasted.map((item) => {
      // The vision task fills hookTypeId after createSwipe returns, so the
      // suggestion arrives via the swipeAnalyses poll, not the save snapshot.
      const suggestedHookId = item.swipe
        ? item.swipe.hookTypeId ?? suggestedHooks.get(item.swipe.id) ?? null
        : null;
      return <article key={item.tempId} className={cn("relative break-inside-avoid overflow-hidden rounded-lg bg-muted", item.status === "saved" && item.tagOpen && "ring-2 ring-amber-400 ring-offset-2 ring-offset-background")}>
      <img src={item.swipe?.imageUrl ?? item.previewUrl} alt="Pasted swipe" className="h-auto w-full" />
      {item.status !== "saved" ? <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-3 text-center text-xs font-medium text-white">{item.status === "uploading" ? <span className="flex items-center gap-2"><Loader2 className="animate-spin" /> Uploading…</span> : <button type="button" className="rounded-md bg-background/95 px-3 py-2 text-foreground" onClick={() => onRetry(item)}>Upload failed — Retry</button>}</div> : null}
      {item.status === "saved" && item.tagOpen ? <div className="space-y-2 border-t bg-card p-2.5">
        <Input className="h-8 text-xs" value={item.brandName} onChange={(event) => onChangePasted(item.tempId, { brandName: event.target.value })} placeholder="Brand name" />
        <div className="flex flex-wrap gap-1">{angles.filter((value) => !value.archivedAt).map((value) => <button key={value.id} type="button" onClick={() => onChangePasted(item.tempId, { angleId: item.angleId === value.id ? "" : value.id })}><Badge variant={item.angleId === value.id ? "default" : "outline"} className="cursor-pointer text-[10px]">{value.name}</Badge></button>)}</div>
        {suggestedHookId ? <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><span>Suggested hook</span>{hooks.filter((value) => value.id === suggestedHookId).map((value) => <button key={value.id} type="button" onClick={() => onChangePasted(item.tempId, { hookTypeId: item.hookTypeId === value.id ? "" : value.id })}><Badge variant={item.hookTypeId === value.id ? "default" : "outline"} className="cursor-pointer text-[10px]">{value.name}</Badge></button>)}</div> : null}
        <div className="flex gap-1.5"><Button size="sm" className="h-7 flex-1 text-xs" onClick={() => onFinishTagging(item, true)}><Check /> Done</Button><Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onFinishTagging(item, false)}>Later</Button></div>
      </div> : null}
    </article>;
    })}
    {swipes.filter((swipe) => !pastedIds.has(swipe.id)).map((swipe) => <article key={swipe.id} className="group relative break-inside-avoid overflow-hidden rounded-lg bg-muted">
      <img src={swipe.imageUrl} alt={swipe.brandName || "Saved swipe"} className="h-auto w-full" />
      <div className="absolute inset-0 flex flex-col justify-between bg-black/65 p-2.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"><div className="flex justify-between"><p className="text-xs font-semibold text-white">{swipe.brandName || "Unknown brand"}</p><div className="flex"><button type="button" className="p-1 text-white/70 hover:text-white" aria-label="Archive swipe" onClick={() => onArchive(swipe.id)}><X /></button><button type="button" className="p-1 text-white/70 hover:text-white" aria-label="Delete swipe" onClick={() => onDelete(swipe.id)}><Trash2 /></button></div></div><div className="space-y-1.5"><div className="flex flex-wrap gap-1">{[swipe.angle?.name, swipe.visualStyle?.name, swipe.hookType?.name].filter(Boolean).map((tag) => <Badge key={tag} className="bg-white/20 text-[10px] text-white">{tag}</Badge>)}</div><Button size="sm" className="h-7 w-full text-xs" onClick={() => onUse(swipe)}>Use as reference <ArrowRight /></Button></div></div>
    </article>)}
  </div>;
}

function SwipeTable({ swipes, onUse, onArchive, onDelete }: { swipes: Swipe[]; onUse: (swipe: Swipe) => void; onArchive: (id: string) => void; onDelete: (id: string) => void }) {
  return <div className="overflow-x-auto rounded-xl border bg-card"><table className="w-full text-sm"><thead><tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground"><th className="p-3 font-medium">Ad</th><th className="p-3 font-medium">Brand</th><th className="p-3 font-medium">Angle</th><th className="p-3 font-medium">Style</th><th className="p-3 font-medium">Why it works</th><th className="p-3" /></tr></thead><tbody>{swipes.map((swipe) => <tr key={swipe.id} className="border-b last:border-0"><td className="p-3"><img src={swipe.imageUrl} alt="" className="h-14 w-11 rounded object-cover" /></td><td className="p-3 font-medium">{swipe.brandName || "—"}</td><td className="p-3 text-xs">{swipe.angle?.name || "—"}</td><td className="p-3 text-xs">{swipe.visualStyle?.name || "—"}</td><td className="max-w-64 p-3 text-xs text-muted-foreground"><span className="line-clamp-2">{swipe.whyItWorks || "—"}</span></td><td className="p-3"><div className="flex justify-end gap-1"><Button size="sm" variant="outline" className="h-7" onClick={() => onUse(swipe)}>Use <ArrowRight /></Button><Button size="icon" variant="ghost" className="size-7" onClick={() => onArchive(swipe.id)} aria-label="Archive"><X /></Button><Button size="icon" variant="ghost" className="size-7" onClick={() => onDelete(swipe.id)} aria-label="Delete"><Trash2 /></Button></div></td></tr>)}</tbody></table></div>;
}

function SwipesContent() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const [view, setView] = useQueryState("view", parseAsString.withDefault("board"));
  const [angleIds, setAngleIds] = useQueryState("angles", parseAsArrayOf(parseAsString).withDefault([]));
  const [styleIds, setStyleIds] = useQueryState("styles", parseAsArrayOf(parseAsString).withDefault([]));
  const [hookTypeIds, setHookTypeIds] = useQueryState("hooks", parseAsArrayOf(parseAsString).withDefault([]));
  const [q, setQ] = useQueryState("q", parseAsString.withDefault(""));
  const [search, setSearch] = useState(q);
  const [active, setActive] = useState<Swipe | null>(null);
  const [pasted, setPasted] = useState<PastedSwipe[]>([]);
  const previewUrls = useRef(new Set<string>());
  const swipes = useQuery(trpc.studio.swipes.queryOptions({
    angleIds: angleIds.length ? angleIds : undefined,
    visualStyleIds: styleIds.length ? styleIds : undefined,
    hookTypeIds: hookTypeIds.length ? hookTypeIds : undefined,
    q: q || undefined,
  }));
  const taxonomy = useQuery(trpc.studio.taxonomies.queryOptions());
  const copyPackages = useQuery(trpc.studio.copyPackages.queryOptions());
  const brandProfile = useQuery(trpc.studio.brandProfile.queryOptions());
  // Vision fills hookTypeId after the save; poll until every open tag strip
  // has its suggestion (or the strip is dismissed).
  const analysisIds = pasted.flatMap((item) =>
    item.status === "saved" && item.swipe && !item.swipe.hookTypeId
      ? [item.swipe.id]
      : [],
  );
  const analyses = useQuery({
    ...trpc.studio.swipeAnalyses.queryOptions({ ids: analysisIds }),
    enabled: analysisIds.length > 0,
    refetchInterval: (query) =>
      query.state.data?.every((row) => row.hookTypeId) ? false : 4000,
  });
  const suggestedHooks = new Map(
    (analyses.data ?? []).map((row) => [row.id, row.hookTypeId]),
  );
  const invalidate = useCallback(
    () => client.invalidateQueries({ queryKey: trpc.studio.swipes.queryKey() }),
    [client, trpc],
  );
  const create = useMutation(trpc.studio.createSwipe.mutationOptions());
  const update = useMutation(trpc.studio.updateSwipe.mutationOptions());
  const archive = useMutation(trpc.studio.archiveSwipe.mutationOptions({ onSuccess: () => void invalidate(), onError: (error) => toast.error(error.message) }));
  const remove = useMutation(trpc.studio.deleteSwipe.mutationOptions({ onSuccess: () => { toast.success("Swipe deleted"); void invalidate(); }, onError: (error) => toast.error(error.message) }));
  const rebrand = useMutation(trpc.studio.rebrandSwipe.mutationOptions({ onSuccess: (result) => { toast.success(result.mode === "queue" ? "Added to this week's queue" : "Generation started — results will appear in Library"); setActive(null); void invalidate(); }, onError: (error) => toast.error(error.message) }));

  useEffect(() => {
    const timeout = window.setTimeout(() => void setQ(search || null), 300);
    return () => window.clearTimeout(timeout);
  }, [search, setQ]);

  useEffect(() => {
    setSearch(q);
  }, [q]);

  useEffect(() => () => {
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
  }, []);

  const savePasted = useCallback(async (tempId: string, file: File) => {
    setPasted((items) => items.map((item) => item.tempId === tempId ? { ...item, status: "uploading" } : item));
    try {
      const imageHash = await sha256(file);
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/upload", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!response.ok || !body?.url) throw new Error(body?.error || "Upload failed");
      const result = await create.mutateAsync({ imageUrl: body.url, imageHash });
      const swipe = { ...result.swipe, angle: null, hookType: null, visualStyle: null } as Swipe;
      setPasted((items) => items.map((item) => item.tempId === tempId ? {
        ...item,
        status: "saved",
        swipe,
        brandName: swipe.brandName ?? "",
        angleId: swipe.angleId ?? "",
        hookTypeId: swipe.hookTypeId ?? "",
        tagOpen: true,
      } : item));
      if (result.duplicateImage) {
        toast.warning(`Looks identical to a swipe saved ${new Date(result.duplicateImage.createdAt).toLocaleDateString()}`);
      }
      void invalidate();
    } catch {
      setPasted((items) => items.map((item) => item.tempId === tempId ? { ...item, status: "failed" } : item));
    }
  }, [create, invalidate]);

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
      const image = Array.from(event.clipboardData?.items ?? []).find((item) => item.type.startsWith("image/"));
      const file = image?.getAsFile();
      if (!file) return;
      event.preventDefault();
      const tempId = crypto.randomUUID();
      const previewUrl = URL.createObjectURL(file);
      previewUrls.current.add(previewUrl);
      setPasted((items) => [{ tempId, file, previewUrl, status: "uploading", brandName: "", angleId: "", hookTypeId: "", tagOpen: true }, ...items]);
      void setView("board");
      void savePasted(tempId, file);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [savePasted, setView]);

  const values = taxonomy.data ?? [];
  const angles = values.filter((value) => value.kind === "angle");
  const styles = values.filter((value) => value.kind === "visual_style");
  const hooks = values.filter((value) => value.kind === "hook_type");
  const rows = swipes.data ?? [];
  const toggle = (selected: string[], id: string, setSelected: (value: string[] | null) => Promise<URLSearchParams>) => {
    void setSelected(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  };
  const changePasted = (tempId: string, next: Partial<PastedSwipe>) => {
    setPasted((items) => items.map((item) => item.tempId === tempId ? { ...item, ...next } : item));
  };
  const dismissPasted = (item: PastedSwipe) => {
    URL.revokeObjectURL(item.previewUrl);
    previewUrls.current.delete(item.previewUrl);
    setPasted((items) => items.filter((candidate) => candidate.tempId !== item.tempId));
    void invalidate();
  };
  const finishTagging = async (item: PastedSwipe, save: boolean) => {
    if (!save || !item.swipe) {
      dismissPasted(item);
      return;
    }
    try {
      await update.mutateAsync({
        id: item.swipe.id,
        brandName: item.brandName || null,
        angleId: item.angleId || null,
        hookTypeId: item.hookTypeId || null,
      });
      dismissPasted(item);
      toast.success("Swipe tagged");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save tags");
    }
  };
  function submit(value: StudioDialogValue, mode: "generate_now" | "queue") { if (!active) return; rebrand.mutate({ swipeId: active.id, brief: value.brief, format: value.format, count: value.count, copyPackageId: value.copyPackageId, mode }); }
  return <>
    <div className="mx-auto w-full max-w-5xl space-y-4 pb-8">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">Swipes</h1><p className="text-sm text-muted-foreground">Your own durable reference library.</p></div><div className="flex gap-2"><Button asChild size="sm" variant="outline"><Link href="/studio/brand">Brand</Link></Button><CopyPackageManager taxonomy={values} /><TaxonomyManager values={values} onChanged={() => void taxonomy.refetch()} /><AddSwipeDialog taxonomy={values} onSaved={() => void invalidate()} /></div></header>
      <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search brands or why it works…" aria-label="Search swipes" />
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-2"><FilterChips values={angles} selected={angleIds} onToggle={(id) => toggle(angleIds, id, setAngleIds)} /><FilterChips values={styles} selected={styleIds} onToggle={(id) => toggle(styleIds, id, setStyleIds)} /><FilterChips values={hooks} selected={hookTypeIds} onToggle={(id) => toggle(hookTypeIds, id, setHookTypeIds)} /></div><div className="flex rounded-lg border p-1"><Button size="sm" variant={view === "board" ? "secondary" : "ghost"} className="h-7" onClick={() => setView("board")}>Board</Button><Button size="sm" variant={view === "table" ? "secondary" : "ghost"} className="h-7" onClick={() => setView("table")}>Table</Button></div></div>
      <div className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"><span className="font-medium text-foreground">⌘V anywhere</span> — a screenshot in your clipboard saves instantly. Tag it now or later.</div>
      {swipes.isLoading && pasted.length === 0 ? <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">{[1,2,3,4].map((i) => <Skeleton key={i} className="aspect-[4/5] rounded-lg" />)}</div> : rows.length === 0 && pasted.length === 0 ? <Empty className="border py-10"><EmptyHeader><EmptyMedia variant="icon"><ImagePlus /></EmptyMedia><EmptyTitle>No swipes here</EmptyTitle><EmptyDescription>Paste or upload a competitor-ad screenshot, or clear the filters.</EmptyDescription></EmptyHeader><EmptyContent /></Empty> : view === "table" ? <SwipeTable swipes={rows} onUse={setActive} onArchive={(id) => archive.mutate({ id, archived: true })} onDelete={(id) => remove.mutate({ id })} /> : <SwipeBoard swipes={rows} pasted={pasted} angles={angles} hooks={hooks} suggestedHooks={suggestedHooks} onUse={setActive} onArchive={(id) => archive.mutate({ id, archived: true })} onDelete={(id) => remove.mutate({ id })} onRetry={(item) => void savePasted(item.tempId, item.file)} onChangePasted={changePasted} onFinishTagging={(item, save) => void finishTagging(item, save)} />}
    </div>
    {active ? <StudioCreateDialog key={active.id} open title="Rebrand this ad" description="The image model will keep the composition while replacing the source brand, product, likeness, and copy." initialValue={{ brief: buildRebrandBrief({ brandName: brandProfile.data?.brandName, sourceBrandName: active.brandName }), format: "square", count: 3, references: [{ url: active.imageUrl, label: active.brandName || "Swipe reference" }] }} copyPackages={copyPackages.data ?? []} pending={rebrand.isPending && rebrand.variables?.mode === "generate_now"} submitLabel="Generate now" onOpenChange={(open) => { if (!open) setActive(null); }} onSubmit={(value) => submit(value, "generate_now")} secondaryAction={{ label: "Queue for this week", pending: rebrand.isPending && rebrand.variables?.mode === "queue", onClick: (value) => submit(value, "queue") }} /> : null}
  </>;
}

export default function SwipesPage() { return <Suspense><SwipesContent /></Suspense>; }
