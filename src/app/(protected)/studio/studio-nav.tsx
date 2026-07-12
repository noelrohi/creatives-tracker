"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Images, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";

const tabs = [
  { label: "Create", href: "/studio", icon: PenLine },
  { label: "Library", href: "/studio/library", icon: Images },
];

export function StudioNav() {
  const pathname = usePathname();
  return (
    <nav className="mx-auto flex w-fit shrink-0 items-center gap-1 rounded-full border bg-muted/40 p-1">
      {tabs.map((tab) => {
        const isActive =
          tab.href === "/studio"
            ? pathname === "/studio"
            : pathname.startsWith("/studio/");
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <tab.icon className="size-3.5" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
