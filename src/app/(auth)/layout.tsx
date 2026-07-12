"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { AdsoluteMark } from "@/components/logo";

const taglines: Record<string, { heading: string; sub: string }> = {
  "/sign-in": {
    heading: "Welcome back",
    sub: "Pick up where you left off.",
  },
  "/sign-up": {
    heading: "Start managing\nyour ads",
    sub: "Create your workspace in seconds.",
  },
  "/accept-invitation": {
    heading: "You've been\ninvited",
    sub: "Join your team's workspace.",
  },
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const copy = taglines[pathname] ?? taglines["/sign-in"];

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      {/* Left — branded panel */}
      <div className="relative hidden overflow-hidden lg:flex lg:items-center lg:justify-center">
        {/* Background image */}
        <Image
          src="https://images.unsplash.com/photo-1557683316-973673baf926?w=1920&q=80&auto=format"
          alt=""
          fill
          className="object-cover"
          priority
        />
        {/* Dark overlay for text legibility */}
        <div className="pointer-events-none absolute inset-0 bg-black/40" />

        <div className="relative z-10 max-w-md px-10">
          <div className="flex items-center gap-2.5 text-white">
            <div className="flex size-8 items-center justify-center rounded-lg bg-[#eae6dc]">
              <AdsoluteMark size={18} />
            </div>
            <span className="text-[15px] font-semibold tracking-tight">
              Adsolute
            </span>
          </div>

          <h1 className="mt-10 whitespace-pre-line text-[clamp(2rem,4vw,3.25rem)] leading-[1.08] font-bold tracking-tight text-white">
            {copy.heading}
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-white/60">
            {copy.sub}
          </p>
        </div>
      </div>

      {/* Right — form panel */}
      <div className="flex min-h-svh flex-col">
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
          {/* Mobile-only logo */}
          <div className="mb-10 flex items-center gap-2.5 lg:hidden">
            <div className="flex size-8 items-center justify-center rounded-lg bg-[#eae6dc]">
              <AdsoluteMark size={18} />
            </div>
            <span className="text-[15px] font-semibold tracking-tight">
              Adsolute
            </span>
          </div>

          <div className="w-full max-w-sm">{children}</div>
        </div>

        <div className="px-6 py-6 text-center text-xs text-muted-foreground/60">
          &copy; 2026 Adsolute
        </div>
      </div>
    </div>
  );
}
