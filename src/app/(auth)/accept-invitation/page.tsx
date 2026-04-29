"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Building2,
  Mail,
  Shield,
  Clock,
} from "lucide-react";

type InvitationDetails = {
  id: string;
  organizationName: string;
  organizationSlug: string;
  inviterEmail: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
};

type PageState =
  | { type: "loading" }
  | { type: "missing-id" }
  | { type: "not-found" }
  | { type: "wrong-account"; currentEmail: string }
  | { type: "expired" }
  | { type: "already-accepted" }
  | { type: "already-rejected" }
  | { type: "valid"; invitation: InvitationDetails }
  | { type: "needs-account"; invitationId: string }
  | { type: "accepted"; orgName: string }
  | { type: "rejected"; orgName: string };

const signUpSchema = z.object({
  name: z.string().min(1, "Name is required."),
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

type SignUpValues = z.infer<typeof signUpSchema>;

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
  const { data: session, isPending: sessionPending } =
    authClient.useSession();
  const [state, setState] = useState<PageState>({ type: "loading" });
  const fetchedRef = useRef(false);

  const fetchInvitation = useCallback(async (id: string, currentEmail: string) => {
    const { data, error } = await authClient.organization.getInvitation({
      query: { id },
    });

    if (error || !data) {
      const message = error?.message?.toLowerCase() ?? "";
      if (message.includes("expired")) {
        setState({ type: "expired" });
      } else if (message.includes("accepted")) {
        setState({ type: "already-accepted" });
      } else if (message.includes("rejected")) {
        setState({ type: "already-rejected" });
      } else if (session) {
        // Authenticated but can't access invitation — most likely email mismatch
        setState({ type: "wrong-account", currentEmail });
      } else {
        setState({ type: "not-found" });
      }
      return;
    }

    setState({
      type: "valid",
      invitation: data as unknown as InvitationDetails,
    });
  }, [session]);

  useEffect(() => {
    if (sessionPending) return;
    if (!invitationId) {
      return;
    }
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    if (!session) {
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- Async invitation lookup must update page state after the request resolves.
    void fetchInvitation(invitationId, session.user.email);
  }, [fetchInvitation, invitationId, session, sessionPending]);

  async function handleAccept() {
    if (!invitationId) return;
    const { error } =
      await authClient.organization.acceptInvitation({ invitationId });

    if (error) {
      toast.error(error.message ?? "Failed to accept invitation");
      return;
    }

    const orgName =
      state.type === "valid" ? state.invitation.organizationName : "";
    setState({ type: "accepted", orgName });
  }

  async function handleReject() {
    if (!invitationId) return;
    const { error } =
      await authClient.organization.rejectInvitation({ invitationId });

    if (error) {
      toast.error(error.message ?? "Failed to decline invitation");
      return;
    }

    const orgName =
      state.type === "valid" ? state.invitation.organizationName : "";
    setState({ type: "rejected", orgName });
  }

  if (!invitationId) {
    return <MissingIdState />;
  }

  if (!sessionPending && !session) {
    return (
      <SignUpAndAccept
        invitationId={invitationId}
        onCreated={() => {
          fetchedRef.current = false;
        }}
      />
    );
  }

  switch (state.type) {
    case "loading":
      return <LoadingState />;
    case "missing-id":
      return <MissingIdState />;
    case "wrong-account":
      return (
        <WrongAccountState
          currentEmail={state.currentEmail}
          invitationId={invitationId!}
        />
      );
    case "not-found":
      return (
        <ErrorState
          title="Invitation not found"
          description="This invitation doesn't exist or the link may be invalid. Please check your invitation email for the correct link."
        />
      );
    case "expired":
      return (
        <ErrorState
          title="Invitation expired"
          description="This invitation has expired. Ask your team admin to send a new one."
        />
      );
    case "already-accepted":
      return (
        <ErrorState
          title="Already accepted"
          description="This invitation has already been accepted. You should already have access to the workspace."
          action={
            <Button onClick={() => router.push("/")} className="w-full">
              Go to dashboard
            </Button>
          }
        />
      );
    case "already-rejected":
      return (
        <ErrorState
          title="Invitation declined"
          description="This invitation was previously declined. Ask your team admin to send a new one if you changed your mind."
        />
      );
    case "needs-account":
      return (
        <SignUpAndAccept
          invitationId={state.invitationId}
          onCreated={() => {
            fetchedRef.current = false;
          }}
        />
      );
    case "valid":
      return (
        <InvitationCard
          invitation={state.invitation}
          onAccept={handleAccept}
          onReject={handleReject}
        />
      );
    case "accepted":
      return <ResultState type="accepted" orgName={state.orgName} />;
    case "rejected":
      return <ResultState type="rejected" orgName={state.orgName} />;
  }
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center gap-3 py-12">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        Loading invitation details...
      </p>
    </div>
  );
}

function MissingIdState() {
  const router = useRouter();
  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertCircle className="size-6 text-destructive" />
      </div>
      <h2 className="text-xl font-semibold tracking-tight">
        Invalid invitation link
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This link is missing an invitation ID. Please use the link from your
        invitation email.
      </p>
      <Button
        variant="outline"
        className="mt-6"
        onClick={() => router.push("/sign-in")}
      >
        Go to sign in
      </Button>
    </div>
  );
}

function WrongAccountState({
  currentEmail,
  invitationId,
}: {
  currentEmail: string;
  invitationId: string;
}) {
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    await authClient.signOut();
    window.location.href = `/accept-invitation?invitationId=${encodeURIComponent(invitationId)}`;
  }

  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-amber-500/10">
        <AlertCircle className="size-6 text-amber-500" />
      </div>
      <h2 className="text-xl font-semibold tracking-tight">
        Wrong account
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        You&apos;re signed in as{" "}
        <span className="font-medium text-foreground">{currentEmail}</span>,
        but this invitation was sent to a different email address. Sign out and
        try again with the correct account.
      </p>
      <Button
        className="mt-6 w-full"
        disabled={signingOut}
        onClick={handleSignOut}
      >
        {signingOut && <Loader2 className="animate-spin" />}
        Sign out
      </Button>
    </div>
  );
}

function ErrorState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertCircle className="size-6 text-destructive" />
      </div>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <div className="mt-6 w-full">
        {action ?? (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => router.push("/sign-in")}
          >
            Go to sign in
          </Button>
        )}
      </div>
    </div>
  );
}

function InvitationCard({
  invitation,
  onAccept,
  onReject,
}: {
  invitation: InvitationDetails;
  onAccept: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [accepting, setAccepting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const busy = accepting || rejecting;

  async function handleAccept() {
    setAccepting(true);
    try {
      await onAccept();
    } finally {
      setAccepting(false);
    }
  }

  async function handleReject() {
    setRejecting(true);
    try {
      await onReject();
    } finally {
      setRejecting(false);
    }
  }

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-xl font-semibold tracking-tight">
          You&apos;ve been invited
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review the details below and choose to accept or decline.
        </p>
      </div>

      <div className="space-y-4 rounded-lg border p-5">
        <div className="flex items-start gap-3">
          <Building2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">
              {invitation.organizationName}
            </p>
            <p className="text-xs text-muted-foreground">Workspace</p>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">{invitation.inviterEmail}</p>
            <p className="text-xs text-muted-foreground">Invited by</p>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <Shield className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="capitalize">
              {invitation.role}
            </Badge>
            <p className="text-xs text-muted-foreground">Your role</p>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">
              {new Date(invitation.expiresAt).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </p>
            <p className="text-xs text-muted-foreground">Expires</p>
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3">
        <Button
          size="lg"
          className="w-full"
          disabled={busy}
          onClick={handleAccept}
        >
          {accepting && <Loader2 className="animate-spin" />}
          Accept invitation
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          disabled={busy}
          onClick={handleReject}
        >
          {rejecting && <Loader2 className="animate-spin" />}
          Decline
        </Button>
      </div>
    </div>
  );
}

function ResultState({
  type,
  orgName,
}: {
  type: "accepted" | "rejected";
  orgName: string;
}) {
  const router = useRouter();
  const accepted = type === "accepted";

  return (
    <div className="flex flex-col items-center text-center">
      <div
        className={`mb-4 flex size-12 items-center justify-center rounded-full ${
          accepted ? "bg-emerald-500/10" : "bg-muted"
        }`}
      >
        {accepted ? (
          <CheckCircle2 className="size-6 text-emerald-500" />
        ) : (
          <XCircle className="size-6 text-muted-foreground" />
        )}
      </div>
      <h2 className="text-xl font-semibold tracking-tight">
        {accepted ? "Welcome aboard" : "Invitation declined"}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {accepted
          ? `You're now a member of ${orgName || "the workspace"}. Head to the dashboard to get started.`
          : `You've declined the invitation${orgName ? ` to ${orgName}` : ""}. You can close this page.`}
      </p>
      {accepted && (
        <Button
          className="mt-6 w-full"
          onClick={() => {
            router.push("/");
            router.refresh();
          }}
        >
          Go to dashboard
        </Button>
      )}
      {!accepted && (
        <Button
          variant="outline"
          className="mt-6 w-full"
          onClick={() => router.push("/sign-in")}
        >
          Go to sign in
        </Button>
      )}
    </div>
  );
}

function SignUpAndAccept({
  invitationId,
  onCreated,
}: {
  invitationId: string;
  onCreated: () => void;
}) {
  const router = useRouter();
  const form = useForm<SignUpValues>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { name: "", email: "", password: "" },
  });

  async function onSubmit(data: SignUpValues) {
    const { error: signUpError } = await authClient.signUp.email({
      name: data.name,
      email: data.email,
      password: data.password,
    });

    if (signUpError) {
      toast.error(signUpError.message ?? "Sign up failed");
      return;
    }

    // Account created — now accept the invitation
    const { error: acceptError } =
      await authClient.organization.acceptInvitation({ invitationId });

    if (acceptError) {
      toast.error(acceptError.message ?? "Failed to accept invitation");
      onCreated();
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-xl font-semibold tracking-tight">
          Create your account
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign up to accept your invitation and join the workspace.
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

      <p className="mt-4 text-center text-xs text-muted-foreground">
        Already have an account?{" "}
        <a
          href={`/sign-in?callbackURL=${encodeURIComponent(`/accept-invitation?invitationId=${invitationId}`)}`}
          className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
        >
          Sign in
        </a>
      </p>
    </div>
  );
}
