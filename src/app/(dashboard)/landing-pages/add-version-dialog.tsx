"use client";

import { useForm, Controller } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { FileUpload } from "@/components/file-upload";
import { MultiSelect } from "@/components/multi-select";
import { toast } from "sonner";

interface VersionData {
  id: string;
  version: number;
  screenshotUrl: string | null;
  pageType: string;
  heroCopy: string;
  benefits: string[];
  socialProofType: string[];
  funnelPosition: string;
  notes: string | null;
}

interface VersionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  landingPageId: string;
  version?: VersionData;
}

export function VersionDialog({
  open,
  onOpenChange,
  landingPageId,
  version,
}: VersionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {version ? `Edit v${version.version}` : "New Version"}
          </DialogTitle>
        </DialogHeader>
        {/* Key forces remount when switching between create/edit, resetting form state */}
        <VersionForm
          key={version?.id ?? "new"}
          landingPageId={landingPageId}
          version={version}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

// Keep backward-compatible export
export { VersionDialog as AddVersionDialog };

// ── Constants ──────────────────────────────────────────────────────

const PAGE_TYPE_OPTIONS = [
  { label: "Product Page", value: "product_page" },
  { label: "Advertorial", value: "advertorial" },
  { label: "Listicle", value: "listicle" },
  { label: "Quiz", value: "quiz" },
  { label: "Other", value: "other" },
] as const;

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
] as const;

// ── Form (child component, initializes from props) ─────────────────

interface FormValues {
  screenshotUrl?: string;
  pageType: "product_page" | "advertorial" | "listicle" | "quiz" | "other";
  heroCopy: string;
  benefitsInput: string;
  socialProofType: string[];
  funnelPosition: "cold_traffic_entry" | "retarget" | "upsell";
  notes: string;
}

function VersionForm({
  landingPageId,
  version,
  onClose,
}: {
  landingPageId: string;
  version?: VersionData;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isEditing = !!version;

  const { register, handleSubmit, control } = useForm<FormValues>({
    defaultValues: version
      ? {
          screenshotUrl: version.screenshotUrl ?? undefined,
          pageType: version.pageType as FormValues["pageType"],
          heroCopy: version.heroCopy,
          benefitsInput: version.benefits.join(", "),
          socialProofType: version.socialProofType,
          funnelPosition: version.funnelPosition as FormValues["funnelPosition"],
          notes: version.notes ?? "",
        }
      : {
          screenshotUrl: undefined,
          pageType: "product_page",
          heroCopy: "",
          benefitsInput: "",
          socialProofType: [],
          funnelPosition: "cold_traffic_entry",
          notes: "",
        },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: trpc.landingPage.getById.queryKey({ id: landingPageId }),
    });
  };

  const createMutation = useMutation({
    ...trpc.landingPage.createVersion.mutationOptions(),
    onSuccess: () => {
      invalidate();
      toast.success("Version created");
      onClose();
    },
    onError: (error) => toast.error(error.message),
  });

  const updateMutation = useMutation({
    ...trpc.landingPage.updateVersion.mutationOptions(),
    onSuccess: () => {
      invalidate();
      toast.success("Version updated");
      onClose();
    },
    onError: (error) => toast.error(error.message),
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const onSubmit = (data: FormValues) => {
    const { benefitsInput, ...rest } = data;
    const benefits = benefitsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (isEditing) {
      updateMutation.mutate({
        id: version.id,
        ...rest,
        benefits,
        screenshotUrl: rest.screenshotUrl || null,
        notes: rest.notes || null,
      });
    } else {
      createMutation.mutate({
        landingPageId,
        ...rest,
        benefits,
        screenshotUrl: rest.screenshotUrl || undefined,
        notes: rest.notes || undefined,
      });
    }
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex flex-col overflow-hidden"
    >
      <div className="relative overflow-y-auto flex-1 px-1 -mx-1 [mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)]">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel>Page Type</FieldLabel>
            <Controller
              name="pageType"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
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
          </Field>

          <Field>
            <FieldLabel>Funnel Position</FieldLabel>
            <Controller
              name="funnelPosition"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
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
          </Field>

          <Field className="sm:col-span-2">
            <FieldLabel>Hero Copy</FieldLabel>
            <Input
              {...register("heroCopy")}
              placeholder="Main headline or hero text"
              required
            />
          </Field>

          <Field className="sm:col-span-2">
            <FieldLabel>Key Benefits</FieldLabel>
            <Input
              {...register("benefitsInput")}
              placeholder="Benefit 1, Benefit 2, Benefit 3"
            />
            <FieldDescription>Separate with commas</FieldDescription>
          </Field>

          <Field className="sm:col-span-2">
            <FieldLabel>Social Proof Type</FieldLabel>
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
          </Field>

          <Field className="sm:col-span-2">
            <FieldLabel>Screenshot</FieldLabel>
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
          </Field>

          <Field className="sm:col-span-2">
            <FieldLabel>Notes</FieldLabel>
            <Textarea
              {...register("notes")}
              placeholder="Optional notes about this version"
            />
          </Field>
        </div>
      </div>

      <DialogFooter className="bg-transparent border-t-0 pt-4 mt-4">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending
            ? isEditing ? "Saving..." : "Creating..."
            : isEditing ? "Save Changes" : "Create Version"}
        </Button>
      </DialogFooter>
    </form>
  );
}
