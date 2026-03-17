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
import { toast } from "sonner";

const schema = z.object({
  name: z.string().min(1, "Name is required"),
  adCreativeId: z.string().min(1, "Ad creative is required"),
  landingPageId: z.string().min(1, "Landing page is required"),
  landingPageVersionId: z.string().min(1, "Landing page version is required"),
  campaignConfigId: z.string().min(1, "Campaign config is required"),
  notes: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

export default function NewAdSetPage() {
  const router = useRouter();
  const trpc = useTRPC();

  const { register, handleSubmit, control, watch, setValue, formState: { isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      adCreativeId: "",
      landingPageId: "",
      landingPageVersionId: "",
      campaignConfigId: "",
      notes: "",
    },
  });

  const landingPageId = watch("landingPageId");

  const creatives = useQuery(trpc.adCreative.list.queryOptions({}));
  const landingPages = useQuery(trpc.landingPage.list.queryOptions());
  const landingPageVersions = useQuery({
    ...trpc.landingPage.listVersions.queryOptions({ landingPageId }),
    enabled: !!landingPageId,
  });
  const campaigns = useQuery(trpc.campaignConfig.list.queryOptions());

  const createAdSet = useMutation({
    ...trpc.adSet.create.mutationOptions(),
    onSuccess: () => {
      toast.success("Ad set created successfully");
      router.push("/ad-sets");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const onSubmit = (data: FormData) => {
    createAdSet.mutate({
      name: data.name,
      adCreativeId: data.adCreativeId,
      landingPageVersionId: data.landingPageVersionId,
      campaignConfigId: data.campaignConfigId,
      notes: data.notes || undefined,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="New Ad Set" description="Create a new ad set." />

      <form onSubmit={handleSubmit(onSubmit)} className="flex max-w-2xl flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            placeholder="Ad set name"
            {...register("name")}
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="adCreative">Ad Creative</Label>
          <Controller
            name="adCreativeId"
            control={control}
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a creative" />
                </SelectTrigger>
                <SelectContent>
                  {creatives.data?.map((creative) => (
                    <SelectItem key={creative.id} value={creative.id}>
                      {creative.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="landingPage">Landing Page</Label>
          <Controller
            name="landingPageId"
            control={control}
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(value);
                  setValue("landingPageVersionId", "");
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a landing page" />
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

        <div className="flex flex-col gap-2">
          <Label htmlFor="landingPageVersion">Landing Page Version</Label>
          <Controller
            name="landingPageVersionId"
            control={control}
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={!landingPageId}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={landingPageId ? "Select a version" : "Select a landing page first"} />
                </SelectTrigger>
                <SelectContent>
                  {landingPageVersions.data?.map((version) => (
                    <SelectItem key={version.id} value={version.id}>
                      v{version.version} — {version.pageType}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="campaignConfig">Campaign Config</Label>
          <Controller
            name="campaignConfigId"
            control={control}
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a campaign" />
                </SelectTrigger>
                <SelectContent>
                  {campaigns.data?.map((campaign) => (
                    <SelectItem key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="notes">Notes (optional)</Label>
          <Textarea
            id="notes"
            placeholder="Any additional notes..."
            {...register("notes")}
          />
        </div>

        <div className="flex gap-2">
          <Button type="submit" disabled={createAdSet.isPending || isSubmitting}>
            {createAdSet.isPending ? "Creating..." : "Create Ad Set"}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.push("/ad-sets")}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
