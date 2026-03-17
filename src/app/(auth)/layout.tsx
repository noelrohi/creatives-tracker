export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <a href="/" className="flex items-center gap-2 font-semibold">
            Adsolute
          </a>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">{children}</div>
        </div>
      </div>
      <div className="bg-muted relative hidden lg:block">
        <div className="absolute inset-0 flex items-center justify-center p-10">
          <div className="text-muted-foreground max-w-md text-center">
            <h2 className="mb-4 text-2xl font-bold">Welcome to Adsolute</h2>
            <p className="text-sm">
              Manage your projects and teams with ease.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
