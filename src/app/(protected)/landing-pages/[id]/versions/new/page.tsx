"use client";

import { useParams, useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileUpload } from "@/components/file-upload";
import { MultiSelect } from "@/components/multi-select";
import { toast } from "sonner";

const PAGE_TYPE_OPTIONS = [
  { label: "Product Page", value: "product_page" },
  { label: "Advertorial", value: "advertorial" },
  { label: "Listicle", value: "listicle" },
  { label: "Quiz", value: "quiz" },
  { label: "Other", value: "other" },
];

const SOCIAL_PROOF_OPTIONS = [
  { label: "Reviews", value: "Reviews" },
  { label: "Before/After", value: "Before/After" },
  { label: "Authority", value: "Authority" },
  { label: "UGC", value: "UGC" },
  { label: "Stats", value: "Stats" },
];

const FUNNEL_POSITION_OPTIONS = [
  { label: "Cold Traffic Entry", value: "cold_traffic_entry" },
  { label: "Retarget", value: "retarget" },
  { label: "Upsell", value: "upsell" },
];

const schema = z.object({
  screenshotUrl: z.string().optional(),
  pageType: z.enum(["product_page", "advertorial", "listicle", "quiz", "other"]),
  heroCopy: z.string().min(1, "Hero copy is required"),
  benefitsInput: z.string(),
  socialProofType: z.array(z.string()),
  funnelPosition: z.enum(["cold_traffic_entry", "retarget", "upsell"]),
  notes: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

export default function NewLandingPageVersionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { register, handleSubmit, control, formState: { isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      screenshotUrl: undefined,
      pageType: "product_page",
      heroCopy: "",
      benefitsInput: "",
      socialProofType: [],
      funnelPosition: "cold_traffic_entry",
      notes: "",
    },
  });

  const createVersionMutation = useMutation({
    ...trpc.landingPage.createVersion.mutationOptions(),
    onSuccess: () => {
      toast.success("Version created");
      queryClient.invalidateQueries(
        trpc.landingPage.getById.queryOptions({ id }),
      );
      router.push(`/landing-pages/${id}`);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const onSubmit = (data: FormData) => {
    const { benefitsInput, ...rest } = data;
    const benefits = benefitsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    createVersionMutation.mutate({
      landingPageId: id,
      ...rest,
      benefits,
      screenshotUrl: rest.screenshotUrl || undefined,
      notes: rest.notes || undefined,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="New Version"
        description="Add a new version to this landing page."
      />

      <Card className="max-w-lg">
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>Screenshot</Label>
              <Controller
                name="screenshotUrl"
                control={control}
                render={({ field }) => (
                  <FileUpload
                    value={field.value}
                    onChange={field.onChange}
                    accept="image/*"
                  />
                )}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="page-type">Page Type</Label>
              <Controller
                name="pageType"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="page-type">
                      <SelectValue placeholder="Select page type" />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_TYPE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="hero-copy">Hero Copy</Label>
              <Input
                id="hero-copy"
                placeholder="Main headline or hero text"
                {...register("heroCopy")}
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="benefits">Key Benefits</Label>
              <Input
                id="benefits"
                placeholder="Benefit 1, Benefit 2, Benefit 3"
                {...register("benefitsInput")}
              />
              <p className="text-xs text-muted-foreground">
                Separate benefits with commas.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Social Proof Type</Label>
              <Controller
                name="socialProofType"
                control={control}
                render={({ field }) => (
                  <MultiSelect
                    options={SOCIAL_PROOF_OPTIONS}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Select social proof types"
                  />
                )}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="funnel-position">Funnel Position</Label>
              <Controller
                name="funnelPosition"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="funnel-position">
                      <SelectValue placeholder="Select funnel position" />
                    </SelectTrigger>
                    <SelectContent>
                      {FUNNEL_POSITION_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                placeholder="Optional notes about this version"
                {...register("notes")}
              />
            </div>

            <Button
              type="submit"
              disabled={createVersionMutation.isPending || isSubmitting}
              className="self-start"
            >
              {createVersionMutation.isPending
                ? "Creating..."
                : "Create Version"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
