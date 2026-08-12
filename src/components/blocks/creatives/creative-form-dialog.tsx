"use client";

import { useForm, useWatch, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MultiSelect } from "@/components/multi-select";
import { FileUpload } from "@/components/file-upload";
import {
  AWARENESS_OPTIONS,
  creativeCreateFormSchema,
  creativeFormSchema,
  FORMAT_OPTIONS,
  getCreativeFormValues,
  hasCreativeExtraValues,
  TONE_OPTIONS,
  toCreativeMutationInput,
  type CreativeFormValues,
} from "@/lib/creative-form";
import { angleLabels } from "@/components/blocks/insights/insights-copy";
import { ANGLE_TYPES } from "@/lib/creative-taxonomy";

/**
 * The three tags the insights breakdowns are built on (spec §6.1). A creative
 * saved without them can never appear in a persona, angle or awareness slice,
 * so we ask for them once, at creation, rather than chasing them later. Editing
 * an older creative stays open: the server allows a partial save, and blocking
 * it here would only trap unrelated edits behind a tagging chore.
 */
const REQUIRED_TAGS = [
  { name: "persona", label: "Persona" },
  { name: "angle", label: "Angle" },
  { name: "awarenessLevel", label: "Awareness level" },
] as const;

const ANGLE_OPTIONS = ANGLE_TYPES.map((value) => ({
  value,
  label: angleLabels[value] ?? value,
}));

function listMissing(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export interface CreativeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creative?: {
    id: string;
    name: string;
    assetUrl: string | null;
    format: string | null;
    angle: string | null;
    persona: string | null;
    awarenessLevel: string | null;
    ownership: string | null;
    attributes: {
      hook?: string;
      cta?: string;
    };
    tone: string[] | null;
    notes: string | null;
  };
  onSuccess?: (id: string) => void;
}

export function CreativeFormDialog({
  open,
  onOpenChange,
  creative,
  onSuccess,
}: CreativeFormDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isEdit = !!creative;

  /**
   * Creating holds the §6.1 line — persona, angle and awareness or no creative;
   * editing does not, so an older untagged creative can still take an unrelated
   * change. Same two schemas the server enforces.
   */
  const form = useForm<CreativeFormValues>({
    resolver: zodResolver(isEdit ? creativeFormSchema : creativeCreateFormSchema),
    values: getCreativeFormValues(creative),
  });

  const createMutation = useMutation({
    ...trpc.adCreative.create.mutationOptions(),
    onError: (error) =>
      toast.error(getUserFacingErrorMessage(error, "Failed to create creative.")),
  });

  const updateMutation = useMutation({
    ...trpc.adCreative.update.mutationOptions(),
    onError: (error) =>
      toast.error(getUserFacingErrorMessage(error, "Failed to update creative.")),
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  /**
   * Which of the three are still empty right now. On create this drives the
   * gate; on edit it only drives the note that says what the creative will be
   * left out of.
   */
  const watched = useWatch({ control: form.control });
  const missing = REQUIRED_TAGS.filter(({ name }) => {
    const value = watched?.[name];
    return typeof value === "string" ? value.trim().length === 0 : !value;
  });

  const missingNames = new Set(missing.map((tag) => tag.name));

  /** A star while the field is being asked for; a quiet word once it is late. */
  const tagMark = (name: (typeof REQUIRED_TAGS)[number]["name"]) => {
    if (!isEdit) {
      return (
        <span aria-hidden className="text-sm text-destructive/70">
          *
        </span>
      );
    }
    return missingNames.has(name) ? (
      <span className="text-xs font-normal text-muted-foreground">missing</span>
    ) : null;
  };

  const currentAngle = typeof watched?.angle === "string" ? watched.angle : "";
  const angleOptions =
    currentAngle && !ANGLE_OPTIONS.some((opt) => opt.value === currentAngle)
      ? [...ANGLE_OPTIONS, { value: currentAngle, label: currentAngle }]
      : ANGLE_OPTIONS;

  const onSubmit = async (values: CreativeFormValues) => {
    const payload = toCreativeMutationInput(values);

    try {
      if (isEdit) {
        await updateMutation.mutateAsync({
          id: creative.id,
          ...payload,
        });
        queryClient.invalidateQueries({
          queryKey: trpc.adCreative.getById.queryKey({ id: creative.id }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.adCreative.list.queryKey(),
        });
        toast.success("Creative updated");
        onOpenChange(false);
        onSuccess?.(creative.id);
      } else {
        // The resolver has already held the §6.1 line; re-reading it here is
        // what turns the three fields into the types `create` asks for.
        const gate = creativeCreateFormSchema.safeParse(values);
        if (!gate.success) {
          for (const { name, label } of REQUIRED_TAGS) {
            if (gate.error.issues.some((issue) => issue.path[0] === name)) {
              form.setError(name, {
                type: "required",
                message: `${label} is required.`,
              });
            }
          }
          return;
        }

        const created = await createMutation.mutateAsync({
          name: payload.name,
          persona: gate.data.persona,
          angle: gate.data.angle,
          awarenessLevel: gate.data.awarenessLevel,
        });

        if (hasCreativeExtraValues(payload)) {
          await updateMutation.mutateAsync({
            id: created.id,
            ...payload,
          });
        }

        queryClient.invalidateQueries({
          queryKey: trpc.adCreative.list.queryKey(),
        });
        toast.success("Creative created");
        onOpenChange(false);
        onSuccess?.(created.id);
      }
    } catch {
      // Error already handled by mutation onError.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        key={`${creative?.id ?? "new"}:${open ? "open" : "closed"}`}
        className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Creative" : "New Creative"}</DialogTitle>
        </DialogHeader>

        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col overflow-hidden"
        >
          <div className="relative -mx-1 flex-1 overflow-y-auto px-1 [mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)]">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                className="sm:col-span-2"
                data-invalid={!!form.formState.errors.name}
              >
                <FieldLabel htmlFor="creative-name">Name</FieldLabel>
                <FieldContent>
                  <Input
                    id="creative-name"
                    {...form.register("name")}
                    placeholder="Creative name"
                  />
                  <FieldError errors={[form.formState.errors.name]} />
                </FieldContent>
              </Field>

              <Field className="sm:col-span-2">
                <FieldLabel>Asset</FieldLabel>
                <Controller
                  control={form.control}
                  name="assetUrl"
                  render={({ field }) => (
                    <FileUpload
                      value={field.value ?? undefined}
                      onChange={(url) => field.onChange(url ?? null)}
                      accept="image/*,video/*"
                    />
                  )}
                />
              </Field>

              <Field>
                <FieldLabel>Format</FieldLabel>
                <Controller
                  control={form.control}
                  name="format"
                  render={({ field }) => (
                    <Select
                      value={field.value ?? ""}
                      onValueChange={(v) => field.onChange(v || null)}
                    >
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
              </Field>

              <Field data-invalid={!!form.formState.errors.awarenessLevel}>
                <FieldLabel>
                  Awareness Level
                  {tagMark("awarenessLevel")}
                </FieldLabel>
                <FieldContent>
                  <Controller
                    control={form.control}
                    name="awarenessLevel"
                    render={({ field }) => (
                      <Select
                        value={field.value ?? ""}
                        onValueChange={(v) => {
                          field.onChange(v || null);
                          form.clearErrors("awarenessLevel");
                        }}
                      >
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
                  <FieldError errors={[form.formState.errors.awarenessLevel]} />
                </FieldContent>
              </Field>

              {/* One of the seven angles, named the way the insights screen
                  names them — a free-text angle could never join a slice. An
                  angle written before this list existed is kept as an option of
                  its own so editing a creative never silently drops it. */}
              <Field data-invalid={!!form.formState.errors.angle}>
                <FieldLabel>
                  Angle
                  {tagMark("angle")}
                </FieldLabel>
                <FieldContent>
                  <Controller
                    control={form.control}
                    name="angle"
                    render={({ field }) => (
                      <Select
                        value={field.value || ""}
                        onValueChange={(v) => {
                          field.onChange(v);
                          form.clearErrors("angle");
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select angle" />
                        </SelectTrigger>
                        <SelectContent>
                          {angleOptions.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <FieldError errors={[form.formState.errors.angle]} />
                </FieldContent>
              </Field>

              <Field data-invalid={!!form.formState.errors.persona}>
                <FieldLabel htmlFor="creative-persona">
                  Persona
                  {tagMark("persona")}
                </FieldLabel>
                <FieldContent>
                  <Input
                    id="creative-persona"
                    {...form.register("persona")}
                    placeholder="e.g., new mom with melasma"
                  />
                  <FieldError errors={[form.formState.errors.persona]} />
                </FieldContent>
              </Field>

              {isEdit && missing.length > 0 ? (
                <FieldDescription className="sm:col-span-2 text-[13px]">
                  {listMissing(missing.map((tag) => tag.label))}{" "}
                  {missing.length === 1 ? "is" : "are"} still missing, so this
                  creative sits out the persona, angle and awareness
                  breakdowns on Creative insights. You can save your other
                  changes now.
                </FieldDescription>
              ) : null}

              <Field className="sm:col-span-2">
                <FieldLabel>Hook</FieldLabel>
                <Input
                  {...form.register("hook")}
                  placeholder="First 3 seconds or headline"
                />
              </Field>

              <Field>
                <FieldLabel>Tone</FieldLabel>
                <Controller
                  control={form.control}
                  name="tone"
                  render={({ field }) => (
                    <MultiSelect
                      options={TONE_OPTIONS}
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="Select tone"
                    />
                  )}
                />
              </Field>

              <Field>
                <FieldLabel>CTA</FieldLabel>
                <Input {...form.register("cta")} placeholder="e.g., Shop Now" />
              </Field>

              <Field className="sm:col-span-2">
                <FieldLabel>Notes</FieldLabel>
                <Textarea
                  {...form.register("notes")}
                  placeholder="Add notes..."
                />
              </Field>
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
