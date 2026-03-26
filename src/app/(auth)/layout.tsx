"use client";

import { usePathname } from "next/navigation";

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
      <div className="relative hidden overflow-hidden bg-foreground lg:flex lg:flex-col lg:justify-between">
        {/* Grid texture */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
            backgroundSize: "64px 64px",
          }}
        />

        {/* Gradient accent blob */}
        <div
          className="pointer-events-none absolute -bottom-1/4 -right-1/4 h-3/4 w-3/4 rounded-full opacity-20 blur-[120px]"
          style={{
            background:
              "radial-gradient(circle, oklch(0.609 0.126 221.723), transparent 70%)",
          }}
        />

        <div className="relative z-10 p-10">
          <div className="flex items-center gap-2.5 text-background">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary">
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                className="text-primary-foreground"
              >
                <path
                  d="M2 12L8 3l6 9H2z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <span className="text-[15px] font-semibold tracking-tight">
              Adsolute
            </span>
          </div>
        </div>

        <div className="relative z-10 flex flex-1 items-end p-10 pb-16">
          <div>
            <h1 className="max-w-md whitespace-pre-line text-[clamp(2rem,4vw,3.25rem)] leading-[1.08] font-bold tracking-tight text-background">
              {copy.heading}
            </h1>
            <p className="mt-4 text-[15px] text-background/50">
              {copy.sub}
            </p>
          </div>
        </div>

        {/* Bottom decorative bar */}
        <div className="relative z-10 flex gap-1 px-10 pb-10">
          <div className="h-1 w-12 rounded-full bg-primary" />
          <div className="h-1 w-6 rounded-full bg-background/15" />
          <div className="h-1 w-6 rounded-full bg-background/10" />
        </div>
      </div>

      {/* Right — form panel */}
      <div className="flex flex-col">
        <div className="flex min-h-svh flex-1 flex-col items-center justify-center px-6 py-12">
          {/* Mobile-only logo */}
          <div className="mb-10 flex items-center gap-2.5 lg:hidden">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary">
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                className="text-primary-foreground"
              >
                <path
                  d="M2 12L8 3l6 9H2z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <span className="text-[15px] font-semibold tracking-tight">
              Adsolute
            </span>
          </div>

          <div className="w-full max-w-[360px]">{children}</div>
        </div>
      </div>
    </div>
  );
}
