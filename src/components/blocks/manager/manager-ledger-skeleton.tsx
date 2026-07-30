import { Skeleton } from "@/components/ui/skeleton";

const SKELETON_ROWS = 8;

// §9 initial load: ~8 skeleton rows at ledger row height (28-30px).
export function ManagerLedgerSkeleton() {
  return (
    <div className="rounded-lg border">
      <div className="divide-y">
        {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
          <div
            key={index}
            className="grid h-[29px] grid-cols-[minmax(0,1fr)_repeat(5,72px)] items-center gap-4 px-3"
          >
            <Skeleton className="h-3 w-full max-w-[280px]" />
            {Array.from({ length: 5 }).map((_, cell) => (
              <Skeleton key={cell} className="h-3 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
