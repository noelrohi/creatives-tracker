"use client";

import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useMutation } from "@tanstack/react-query";
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
import { toast } from "sonner";

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

const schema = z.object({
  name: z.string().min(1, "Name is required"),
  assetUrl: z.string().optional(),
  format: z.enum(["static", "video", "ugc", "carousel"]),
  angle: z.string().min(1, "Angle is required"),
  persona: z.string().min(1, "Persona is required"),
  awarenessLevel: z.enum(["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware"]),
  hook: z.string().min(1, "Hook is required"),
  tone: z.array(z.string()).min(1, "Select at least one tone"),
  cta: z.string().min(1, "CTA is required"),
  landingPageId: z.string().optional(),
  notes: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

export default function NewCreativePage() {
  const trpc = useTRPC();
  const router = useRouter();

  const { register, handleSubmit, control, formState: { isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      assetUrl: undefined,
      format: "static",
      angle: "",
      persona: "",
      awarenessLevel: "unaware",
      hook: "",
      tone: [],
      cta: "",
      landingPageId: "",
      notes: "",
    },
  });

  const landingPages = useQuery(trpc.landingPage.list.queryOptions());

  const createMutation = useMutation({
    ...trpc.adCreative.create.mutationOptions(),
    onSuccess: () => {
      toast.success("Creative created successfully");
      router.push("/creatives");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create creative");
    },
  });

  const onSubmit = (data: FormData) => {
    createMutation.mutate({
      ...data,
      landingPageId: data.landingPageId || undefined,
      notes: data.notes || undefined,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="New Creative"
        description="Create a new ad creative with resolution tags."
      />

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="Creative name"
                {...register("name")}
                required
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
                placeholder="Creative angle"
                {...register("angle")}
                required
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="persona">Target Persona</Label>
              <Input
                id="persona"
                placeholder="Target persona"
                {...register("persona")}
                required
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
                placeholder="Hook line"
                {...register("hook")}
                required
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
                placeholder="Call to action"
                {...register("cta")}
                required
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
                      {landingPages.data?.map((lp) => (
                        <SelectItem key={lp.id} value={lp.id}>
                          {lp.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                placeholder="Optional notes..."
                rows={3}
                {...register("notes")}
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
              <Button type="submit" disabled={createMutation.isPending || isSubmitting}>
                {createMutation.isPending ? "Creating..." : "Create Creative"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
