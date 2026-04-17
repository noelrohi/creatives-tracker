"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useQueryState, parseAsString } from "nuqs";
import { useTRPC } from "@/lib/trpc/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileSpreadsheet, Cloud } from "lucide-react";
import { CsvImportTab } from "@/components/blocks/import/csv-import-tab";
import { MetaApiTab } from "@/components/blocks/import/meta-api-tab";
import { InlineAccountDialog } from "@/components/blocks/import/inline-account-dialog";
import { formatDateOnly } from "@/lib/date";

function defaultFrom() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return formatDateOnly(d);
}

export default function ImportPage() {
  const trpc = useTRPC();
  const accountsQuery = useQuery(trpc.adAccount.list.queryOptions());
  const accounts = accountsQuery.data ?? [];

  const [tab, setTab] = useQueryState("tab", parseAsString.withDefault("meta-api"));
  const [accountId, setAccountId] = useQueryState("account", parseAsString.withDefault(""));
  const [from, setFrom] = useQueryState("from", parseAsString.withDefault(defaultFrom()));
  const [to, setTo] = useQueryState("to", parseAsString.withDefault(formatDateOnly(new Date())));

  const [dialogOpen, setDialogOpen] = useState(false);
  const [promptForToken, setPromptForToken] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Import Ads</h1>
        <p className="text-sm text-muted-foreground">
          Import ad performance data from CSV reports or the Meta Marketing API.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="meta-api">
            <Cloud className="size-4" />
            From Meta
          </TabsTrigger>
          <TabsTrigger value="csv">
            <FileSpreadsheet className="size-4" />
            CSV Report
          </TabsTrigger>
        </TabsList>

        <TabsContent value="csv" className="mt-6">
          <CsvImportTab
            accounts={accounts}
            selectedAccountId={accountId || null}
            onSelectAccount={setAccountId}
            onRequestCreateAccount={() => {
              setPromptForToken(false);
              setDialogOpen(true);
            }}
          />
        </TabsContent>

        <TabsContent value="meta-api" className="mt-6">
          <MetaApiTab
            accounts={accounts}
            accountId={accountId}
            onAccountIdChange={setAccountId}
            dateFrom={from}
            onDateFromChange={setFrom}
            dateTo={to}
            onDateToChange={setTo}
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
          setAccountId(account.id);
          setDialogOpen(false);
        }}
      />
    </div>
  );
}
