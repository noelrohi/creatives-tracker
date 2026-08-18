"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const tabs = [
  { label: "Competitors", href: "/competitors" },
  { label: "Signals", href: "/competitors/signals" },
  { label: "Test plan", href: "/competitors/test-plan" },
];

export default function CompetitorsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex w-fit items-center gap-1 rounded-full border bg-muted/40 p-1">
        {tabs.map((tab) => {
          // The Competitors tab owns every /competitors route the other tabs
          // don't claim — including the per-competitor ad grid.
          const isActive =
            tab.href === "/competitors"
              ? tabs
                  .slice(1)
                  .every((other) => !pathname.startsWith(other.href))
              : pathname.startsWith(tab.href);

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "rounded-full px-3 py-1 text-sm font-medium transition-colors",
                isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
