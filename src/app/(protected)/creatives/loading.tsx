import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  const heights = [180, 140, 200, 160, 220, 150, 190, 170];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-6 w-24" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 [&>*]:mb-3 [&>*]:break-inside-avoid">
        {heights.map((h, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-border">
            <Skeleton className="w-full rounded-b-none rounded-t-lg" style={{ height: h }} />
            <div className="space-y-1.5 px-2.5 pb-2.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
