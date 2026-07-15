"use client";
/* eslint-disable @next/next/no-img-element */

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ImagePlus, Loader2, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useTRPC, type RouterOutputs } from "@/lib/trpc/client";

type BrandProfile = RouterOutputs["studio"]["brandProfile"];

function BrandForm({ initial }: { initial: BrandProfile }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [brandName, setBrandName] = useState(initial?.brandName ?? "");
  const [productDescription, setProductDescription] = useState(
    initial?.productDescription ?? "",
  );
  const [offer, setOffer] = useState(initial?.offer ?? "");
  const [productNotes, setProductNotes] = useState(initial?.productNotes ?? "");
  const [prohibitedClaims, setProhibitedClaims] = useState(
    initial?.prohibitedClaims.join("\n") ?? "",
  );
  const [requiredDisclaimers, setRequiredDisclaimers] = useState(
    initial?.requiredDisclaimers.join("\n") ?? "",
  );
  const [productImageUrl, setProductImageUrl] = useState(
    initial?.productImageUrl ?? "",
  );
  const [uploading, setUploading] = useState(false);
  const save = useMutation(
    trpc.studio.saveBrandProfile.mutationOptions({
      onSuccess: () => {
        toast.success("Brand profile saved");
        void client.invalidateQueries({
          queryKey: trpc.studio.brandProfile.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  async function upload(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Choose an image file.");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/upload", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!response.ok || !body?.url) throw new Error(body?.error || "Upload failed");
      setProductImageUrl(body.url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
      <div className="space-y-1.5">
        <div className="relative">
          <button
            type="button"
            className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/40 text-sm text-muted-foreground"
            onClick={() => fileRef.current?.click()}
          >
            {productImageUrl ? (
              <img src={productImageUrl} alt="Product" className="size-full object-cover" />
            ) : uploading ? (
              <Loader2 className="animate-spin" />
            ) : (
              <span className="flex flex-col items-center gap-2"><ImagePlus /> Product photo</span>
            )}
          </button>
          {productImageUrl ? (
            <button
              type="button"
              className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1 text-white/80 hover:text-white"
              aria-label="Remove product photo"
              onClick={() => setProductImageUrl("")}
            >
              <X />
            </button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Sent as a reference image so generated ads show your real product.
        </p>
      </div>
      <input ref={fileRef} hidden type="file" accept="image/*" onChange={(event) => void upload(event.target.files?.[0])} />
      <div className="space-y-3">
        <Input
          value={brandName}
          onChange={(event) => setBrandName(event.target.value)}
          placeholder="Brand name"
        />
        <Textarea
          value={productDescription}
          onChange={(event) => setProductDescription(event.target.value)}
          placeholder="What the product is and who it's for, in a sentence or two"
          className="min-h-24"
        />
        <Input
          value={offer}
          onChange={(event) => setOffer(event.target.value)}
          placeholder="Current offer or guarantee (optional)"
        />
        <Textarea
          value={productNotes}
          onChange={(event) => setProductNotes(event.target.value)}
          placeholder={'Product details the photo can miss, e.g. shallow "Reviv" wordmark debossed on the front face (optional)'}
          className="min-h-20"
        />
        <Textarea
          value={prohibitedClaims}
          onChange={(event) => setProhibitedClaims(event.target.value)}
          placeholder="Prohibited claims (one per line)"
          className="min-h-24"
        />
        <Textarea
          value={requiredDisclaimers}
          onChange={(event) => setRequiredDisclaimers(event.target.value)}
          placeholder="Required disclaimers (one per line)"
          className="min-h-24"
        />
        <Button
          disabled={!brandName.trim() || !productDescription.trim() || uploading || save.isPending}
          onClick={() =>
            save.mutate({
              brandName,
              productDescription,
              offer: offer.trim() || undefined,
              productNotes: productNotes.trim() || undefined,
              productImageUrl: productImageUrl || null,
              prohibitedClaims: prohibitedClaims
                .split("\n")
                .map((claim) => claim.trim())
                .filter(Boolean),
              requiredDisclaimers: requiredDisclaimers
                .split("\n")
                .map((disclaimer) => disclaimer.trim())
                .filter(Boolean),
            })
          }
        >
          {save.isPending ? <Loader2 className="animate-spin" /> : <Check />} Save brand profile
        </Button>
      </div>
    </div>
  );
}

export default function BrandPage() {
  const trpc = useTRPC();
  const profile = useQuery(trpc.studio.brandProfile.queryOptions());
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 pb-8">
      <header>
        <h1 className="text-xl font-semibold">Brand</h1>
        <p className="text-sm text-muted-foreground">
          Who &ldquo;our brand&rdquo; is when Studio generates or rebrands ads. Without
          it the image model invents a generic product.
        </p>
      </header>
      {profile.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
          <Skeleton className="aspect-square rounded-lg" />
          <div className="space-y-3">
            <Skeleton className="h-9" />
            <Skeleton className="h-24" />
            <Skeleton className="h-9" />
          </div>
        </div>
      ) : (
        <BrandForm initial={profile.data ?? null} />
      )}
    </div>
  );
}
