"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { authClient } from "@/lib/auth-client";
import { createOrganizationWithUniqueSlug } from "@/lib/organization-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";

type FormValues = {
  name: string;
};

export default function CreateOrganizationPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState("");
  const form = useForm<FormValues>({
    defaultValues: { name: "" },
  });

  async function onSubmit(values: FormValues) {
    setServerError("");

    try {
      const organization = await createOrganizationWithUniqueSlug(values.name);
      const { error } = await authClient.organization.setActive({
        organizationId: organization.id,
      });

      if (error) {
        setServerError(error.message ?? "Failed to activate organization");
        return;
      }

      router.push("/");
      router.refresh();
    } catch (error) {
      setServerError(
        error instanceof Error
          ? error.message
          : "Failed to create organization",
      );
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">
          Create your organization
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your account exists, but you need an organization before using the app.
        </p>
      </div>

      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-5"
      >
        <Field data-invalid={Boolean(form.formState.errors.name)}>
          <FieldLabel htmlFor="org-name">Organization name</FieldLabel>
          <Input
            id="org-name"
            placeholder="My Company"
            autoFocus
            {...form.register("name", { required: "Organization name is required." })}
          />
          {form.formState.errors.name && (
            <FieldError errors={[form.formState.errors.name]} />
          )}
        </Field>

        {serverError && <p className="text-sm text-destructive">{serverError}</p>}

        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "Creating..." : "Create organization"}
        </Button>
      </form>
    </div>
  );
}
