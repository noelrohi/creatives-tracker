import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center">
      <Skeleton className="mb-6 h-8 w-72" />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <div className="mt-6 w-full space-y-2">
        <Skeleton className="h-6 w-40" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}
