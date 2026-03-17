"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";

const schema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.string().url("Must be a valid URL"),
});

type FormData = z.infer<typeof schema>;

export default function NewLandingPagePage() {
  const trpc = useTRPC();
  const router = useRouter();

  const { register, handleSubmit, formState: { isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", url: "" },
  });

  const createMutation = useMutation({
    ...trpc.landingPage.create.mutationOptions(),
    onSuccess: (data) => {
      toast.success("Landing page created");
      router.push(`/landing-pages/${data.id}`);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const onSubmit = (data: FormData) => {
    createMutation.mutate(data);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="New Landing Page"
        description="Create a new landing page to track."
      />

      <Card className="max-w-lg">
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="e.g. Product Page V1"
                {...register("name")}
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="url">URL</Label>
              <Input
                id="url"
                type="url"
                placeholder="https://example.com/page"
                {...register("url")}
                required
              />
            </div>

            <Button
              type="submit"
              disabled={createMutation.isPending || isSubmitting}
              className="self-start"
            >
              {createMutation.isPending ? "Creating..." : "Create Landing Page"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
