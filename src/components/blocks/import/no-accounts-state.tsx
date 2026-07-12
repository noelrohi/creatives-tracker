import { Button } from "@/components/ui/button";
import { CirclePlus, Settings } from "@/components/icons";

export function NoAccountsState({
  onCreateAccount,
}: {
  onCreateAccount: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-muted">
        <Settings className="size-5 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-medium">No ad accounts yet</h3>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        Create an ad account to start importing performance data from Meta Ads
        Manager.
      </p>
      <Button onClick={onCreateAccount} className="mt-4" size="sm">
        <CirclePlus className="size-4" />
        Create account
      </Button>
    </div>
  );
}
