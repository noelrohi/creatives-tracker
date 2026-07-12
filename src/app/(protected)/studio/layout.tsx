import { redirect } from "next/navigation";
import { isImageStudioEnabled } from "@/lib/image-studio-enabled";
import { StudioNav } from "./studio-nav";

export default function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isImageStudioEnabled()) redirect("/");

  return (
    <div className="flex h-full flex-col gap-4">
      <StudioNav />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
