import { StudioNav } from "./studio-nav";

export default function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col gap-4">
      <StudioNav />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
