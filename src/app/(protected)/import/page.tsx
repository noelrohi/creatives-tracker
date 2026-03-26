"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileSpreadsheet, Cloud } from "lucide-react";
import { CsvImportTab } from "@/components/blocks/import/csv-import-tab";
import { MetaApiTab } from "@/components/blocks/import/meta-api-tab";
import { InlineAccountDialog } from "@/components/blocks/import/inline-account-dialog";

export default function ImportPage() {
  const trpc = useTRPC();
  const accountsQuery = useQuery(trpc.adAccount.list.queryOptions());
  const accounts = accountsQuery.data ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [promptForToken, setPromptForToken] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    null,
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Import Ads</h1>
        <p className="text-sm text-muted-foreground">
          Import ad performance data from CSV reports or the Meta Marketing API.
        </p>
      </div>

      <Tabs defaultValue="csv">
        <TabsList>
          <TabsTrigger value="csv">
            <FileSpreadsheet className="size-4" />
            Import Reports
          </TabsTrigger>
          <TabsTrigger value="meta-api">
            <Cloud className="size-4" />
            Meta Marketing API
          </TabsTrigger>
        </TabsList>

        <TabsContent value="csv" className="mt-6">
          <CsvImportTab
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            onSelectAccount={setSelectedAccountId}
            onRequestCreateAccount={() => {
              setPromptForToken(false);
              setDialogOpen(true);
            }}
          />
        </TabsContent>

        <TabsContent value="meta-api" className="mt-6">
          <MetaApiTab
            accounts={accounts}
            onRequestCreateAccount={() => {
              setPromptForToken(true);
              setDialogOpen(true);
            }}
          />
        </TabsContent>
      </Tabs>

      <InlineAccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        promptForToken={promptForToken}
        onSuccess={(account) => {
          setSelectedAccountId(account.id);
          setDialogOpen(false);
        }}
      />
    </div>
  );
}
