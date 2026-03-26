"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { Loader2, AlertCircle } from "lucide-react";

const acceptSchema = z.object({
  name: z.string().min(1, "Name is required."),
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

type AcceptValues = z.infer<typeof acceptSchema>;

export default function AcceptInvitationPage() {
  return (
    <Suspense>
      <AcceptInvitationContent />
    </Suspense>
  );
}

function AcceptInvitationContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invitationId = searchParams.get("invitationId");
  const hasShownMissingInvitationToast = useRef(false);
  const { data: session } = authClient.useSession();

  const form = useForm<AcceptValues>({
    resolver: zodResolver(acceptSchema),
    defaultValues: { name: "", email: "", password: "" },
  });

  useEffect(() => {
    if (!invitationId && !hasShownMissingInvitationToast.current) {
      hasShownMissingInvitationToast.current = true;
      toast.error(
        "No invitation found. Please use the link from your invitation email.",
      );
    }
  }, [invitationId]);

  async function onSubmit(data: AcceptValues) {
    if (!invitationId) return;

    if (!session) {
      const { error: signUpError } = await authClient.signUp.email({
        name: data.name,
        email: data.email,
        password: data.password,
      });

      if (signUpError) {
        toast.error(signUpError.message ?? "Sign up failed");
        return;
      }
    }

    const { error: acceptError } =
      await authClient.organization.acceptInvitation({ invitationId });

    if (acceptError) {
      toast.error(acceptError.message ?? "Failed to accept invitation");
      return;
    }

    router.push("/");
    router.refresh();
  }

  async function handleAcceptOnly(e: React.FormEvent) {
    e.preventDefault();
    if (!invitationId) return;

    const { error: acceptError } =
      await authClient.organization.acceptInvitation({ invitationId });

    if (acceptError) {
      toast.error(acceptError.message ?? "Failed to accept invitation");
      return;
    }

    router.push("/");
    router.refresh();
  }

  // No invitation ID
  if (!invitationId) {
    return (
      <div className="flex flex-col items-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="size-6 text-destructive" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">
          Invalid invitation
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          No invitation found. Please use the link from your invitation email.
        </p>
      </div>
    );
  }

  // Already signed in — just accept
  if (session) {
    return (
      <div>
        <div className="mb-8">
          <h2 className="text-xl font-semibold tracking-tight">
            Accept invitation
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            You&apos;re signed in as{" "}
            <span className="font-medium text-foreground">
              {session.user.email}
            </span>
            . Click below to join the organization.
          </p>
        </div>

        <form onSubmit={handleAcceptOnly}>
          <Button type="submit" size="lg" className="w-full">
            Accept invitation
          </Button>
        </form>
      </div>
    );
  }

  // New user — sign up + accept
  return (
    <div>
      <div className="mb-8">
        <h2 className="text-xl font-semibold tracking-tight">
          Accept invitation
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Create your account to join the organization.
        </p>
      </div>

      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-5"
      >
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={field.name}>Name</FieldLabel>
              <Input
                {...field}
                id={field.name}
                aria-invalid={fieldState.invalid}
                autoComplete="name"
                autoFocus
              />
              {fieldState.invalid && (
                <FieldError errors={[fieldState.error]} />
              )}
            </Field>
          )}
        />

        <Controller
          name="email"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={field.name}>Email</FieldLabel>
              <Input
                {...field}
                id={field.name}
                type="email"
                aria-invalid={fieldState.invalid}
                autoComplete="email"
              />
              {fieldState.invalid && (
                <FieldError errors={[fieldState.error]} />
              )}
            </Field>
          )}
        />

        <Controller
          name="password"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={field.name}>Password</FieldLabel>
              <Input
                {...field}
                id={field.name}
                type="password"
                aria-invalid={fieldState.invalid}
                autoComplete="new-password"
              />
              {fieldState.invalid && (
                <FieldError errors={[fieldState.error]} />
              )}
            </Field>
          )}
        />

        <Button
          type="submit"
          size="lg"
          className="mt-1 w-full"
          disabled={form.formState.isSubmitting}
        >
          {form.formState.isSubmitting && (
            <Loader2 className="animate-spin" />
          )}
          Create account & join
        </Button>
      </form>
    </div>
  );
}
