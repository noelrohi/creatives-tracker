"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession, organization } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function SetupOrgPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isPending && !session) {
      router.push("/sign-in");
    }
  }, [session, isPending, router]);

  function handleNameChange(value: string) {
    setName(value);
    setSlug(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await organization.create({
      name,
      slug,
    });

    if (result.error) {
      setError(result.error.message ?? "Something went wrong");
      setLoading(false);
      return;
    }

    await organization.setActive({
      organizationId: result.data!.id,
    });

    window.location.href = "/";
  }

  if (isPending) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold">Set up your workspace</h1>
        <p className="text-muted-foreground text-sm">
          Create a workspace to get started
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create a workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Workspace name</Label>
              <Input
                id="name"
                placeholder="My Company"
                required
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="slug">Slug</Label>
              <Input
                id="slug"
                placeholder="my-company"
                required
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Auto-generated from the name. You can customize it.
              </p>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Creating..." : "Create workspace"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Or join via invitation</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            If you&apos;ve been invited, check your email for the invitation
            link.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
