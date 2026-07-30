"use client";

import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import { Search } from "@/components/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateOnly } from "@/lib/date";
import {
  MANAGER_STATUSES,
  type ManagerStatus,
} from "./use-manager-filters";

type AccountOption = { id: string; name: string };

export function ManagerFilterBar({
  accounts,
  accountId,
  onAccountIdChange,
  status,
  onStatusChange,
  searchInput,
  onSearchInputChange,
  fromDate,
  toDate,
  onFromChange,
  onToChange,
}: {
  accounts: AccountOption[];
  accountId: string;
  onAccountIdChange: (value: string) => void;
  status: ManagerStatus | null;
  onStatusChange: (value: ManagerStatus | null) => void;
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  fromDate: Date | undefined;
  toDate: Date | undefined;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DateRangePicker
        from={fromDate}
        to={toDate}
        onChange={(range) => {
          if (range) {
            onFromChange(formatDateOnly(range.from));
            onToChange(formatDateOnly(range.to));
          }
        }}
      />
      <Select
        value={accountId || "all"}
        onValueChange={(value) => onAccountIdChange(value === "all" ? "" : value)}
      >
        <SelectTrigger size="sm" className="w-auto gap-1.5 text-[13px] [&>svg]:size-3">
          <SelectValue placeholder="Account" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All accounts</SelectItem>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {account.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={status ?? "all"}
        onValueChange={(value) =>
          onStatusChange(value === "all" ? null : (value as ManagerStatus))
        }
      >
        <SelectTrigger size="sm" className="w-auto gap-1.5 text-[13px] capitalize [&>svg]:size-3">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          {MANAGER_STATUSES.map((value) => (
            <SelectItem key={value} value={value} className="capitalize">
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="relative max-w-xs">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
        <input
          placeholder="Search names..."
          value={searchInput}
          onChange={(event) => onSearchInputChange(event.target.value)}
          className="h-7 w-full rounded-md border border-input bg-transparent pl-8 pr-2.5 text-[13px] outline-none placeholder:text-muted-foreground/40 focus-visible:border-ring transition-colors"
        />
      </div>
    </div>
  );
}
