"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTRPC } from "@/lib/trpc/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { MultiSelect } from "@/components/multi-select";
import { FileUpload } from "@/components/file-upload";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

const FORMAT_OPTIONS = [
  { label: "Static", value: "static" },
  { label: "Video", value: "video" },
  { label: "UGC", value: "ugc" },
  { label: "Carousel", value: "carousel" },
];

const AWARENESS_OPTIONS = [
  { label: "Unaware", value: "unaware" },
  { label: "Problem Aware", value: "problem_aware" },
  { label: "Solution Aware", value: "solution_aware" },
  { label: "Product Aware", value: "product_aware" },
  { label: "Most Aware", value: "most_aware" },
];

const TONE_OPTIONS = [
  { label: "Clinical", value: "clinical" },
  { label: "Casual", value: "casual" },
  { label: "Fear-based", value: "fear_based" },
  { label: "Aspirational", value: "aspirational" },
  { label: "Urgent", value: "urgent" },
  { label: "Humorous", value: "humorous" },
];

const editCreativeSchema = z.object({
  name: z.string().min(1),
  assetUrl: z.string().optional(),
  format: z.enum(["static", "video", "ugc", "carousel"]),
  angle: z.string().min(1),
  persona: z.string().min(1),
  awarenessLevel: z.enum(["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware"]),
  hook: z.string().min(1),
  tone: z.array(z.string()),
  cta: z.string().min(1),
  landingPageId: z.string().optional(),
  notes: z.string().optional(),
});

type EditCreativeFormValues = z.infer<typeof editCreativeSchema>;

type CreativeData = {
  id: string;
  name: string;
  assetUrl: string | null;
  format: "static" | "video" | "ugc" | "carousel";
  angle: string;
  persona: string;
  awarenessLevel: "unaware" | "problem_aware" | "solution_aware" | "product_aware" | "most_aware";
  hook: string;
  tone: string[] | null;
  cta: string;
  landingPageId: string | null;
  landingPageName: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type LandingPage = {
  id: string;
  name: string;
  url: string;
  createdBy: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export default function CreativeDetailPage() {
  const trpc = useTRPC();
  const params = useParams();
  const id = params.id as string;

  const creative = useQuery(trpc.adCreative.getById.queryOptions({ id }));
  const landingPages = useQuery(trpc.landingPage.list.queryOptions());

  if (creative.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-9 w-24" />
        </div>
        <Card><CardContent className="pt-6 flex flex-col gap-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="grid gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </CardContent></Card>
      </div>
    );
  }

  if (creative.isError || !creative.data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Creative not found" />
      </div>
    );
  }

  return (
    <EditCreativeForm
      key={id}
      data={creative.data}
      landingPages={landingPages.data ?? []}
    />
  );
}

function EditCreativeForm({
  data,
  landingPages,
}: {
  data: CreativeData;
  landingPages: LandingPage[];
}) {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    control,
    formState: { isSubmitting },
  } = useForm<EditCreativeFormValues>({
    resolver: zodResolver(editCreativeSchema),
    defaultValues: {
      name: data.name,
      assetUrl: data.assetUrl ?? undefined,
      format: data.format,
      angle: data.angle,
      persona: data.persona,
      awarenessLevel: data.awarenessLevel,
      hook: data.hook,
      tone: data.tone ?? [],
      cta: data.cta,
      landingPageId: data.landingPageId ?? "",
      notes: data.notes ?? "",
    },
  });

  const updateMutation = useMutation({
    ...trpc.adCreative.update.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });
      queryClient.invalidateQueries({
        queryKey: trpc.adCreative.getById.queryKey({ id: data.id }),
      });
      toast.success("Creative updated successfully");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update creative");
    },
  });

  const deleteMutation = useMutation({
    ...trpc.adCreative.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });
      toast.success("Creative deleted");
      router.push("/creatives");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete creative");
    },
  });

  const onSubmit = (formData: EditCreativeFormValues) => {
    updateMutation.mutate({
      id: data.id,
      ...formData,
      landingPageId: formData.landingPageId || undefined,
      notes: formData.notes || undefined,
    });
  };

  const handleDelete = () => {
    if (confirm("Are you sure you want to delete this creative?")) {
      deleteMutation.mutate({ id: data.id });
    }
  };

  const linkedLandingPage = landingPages.find(
    (lp) => lp.id === data.landingPageId,
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={data.name}
        description="Edit creative details and resolution tags."
      >
        <Button
          variant="destructive"
          onClick={handleDelete}
          disabled={deleteMutation.isPending}
        >
          <Trash2 className="mr-2 size-4" />
          {deleteMutation.isPending ? "Deleting..." : "Delete"}
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                {...register("name")}
                placeholder="Creative name"
              />
            </div>

            <div className="grid gap-2">
              <Label>Asset</Label>
              <Controller
                name="assetUrl"
                control={control}
                render={({ field }) => (
                  <FileUpload
                    value={field.value}
                    onChange={field.onChange}
                    accept="image/*,video/*"
                  />
                )}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="format">Format</Label>
              <Controller
                name="format"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select format" />
                    </SelectTrigger>
                    <SelectContent>
                      {FORMAT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="angle">Angle</Label>
              <Input
                id="angle"
                {...register("angle")}
                placeholder="Creative angle"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="persona">Target Persona</Label>
              <Input
                id="persona"
                {...register("persona")}
                placeholder="Target persona"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="awarenessLevel">Awareness Level</Label>
              <Controller
                name="awarenessLevel"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select awareness level" />
                    </SelectTrigger>
                    <SelectContent>
                      {AWARENESS_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="hook">Hook</Label>
              <Input
                id="hook"
                {...register("hook")}
                placeholder="Hook line"
              />
            </div>

            <div className="grid gap-2">
              <Label>Tone</Label>
              <Controller
                name="tone"
                control={control}
                render={({ field }) => (
                  <MultiSelect
                    options={TONE_OPTIONS}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Select tones..."
                  />
                )}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="cta">CTA</Label>
              <Input
                id="cta"
                {...register("cta")}
                placeholder="Call to action"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="landingPage">Destination Landing Page</Label>
              <Controller
                name="landingPageId"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select landing page" />
                    </SelectTrigger>
                    <SelectContent>
                      {landingPages.map((lp) => (
                        <SelectItem key={lp.id} value={lp.id}>
                          {lp.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {linkedLandingPage && (
                <p className="text-sm text-muted-foreground">
                  Currently linked to{" "}
                  <Link
                    href={`/landing-pages/${linkedLandingPage.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {linkedLandingPage.name}
                  </Link>
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                {...register("notes")}
                placeholder="Optional notes..."
                rows={3}
              />
            </div>

            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push("/creatives")}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updateMutation.isPending || isSubmitting}>
                {updateMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
