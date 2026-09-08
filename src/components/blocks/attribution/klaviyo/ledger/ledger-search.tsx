"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

/**
 * Debounced so each keystroke does not become a ledger query. An external
 * change to `value` — "Clear filters", a back navigation — wins over a
 * pending draft, so the cleared search can never be written back to the URL.
 */
export function LedgerSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // The timer fires the latest callback without restarting on its identity,
  // so an inline arrow in the parent cannot keep resetting the debounce. The
  // ref syncs in its own effect (writing it during render trips the compiler);
  // that effect always runs before the 300 ms timer can read it.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const [syncedValue, setSyncedValue] = useState(value);
  if (syncedValue !== value) {
    setSyncedValue(value);
    setDraft(value);
  }
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChangeRef.current(draft), 300);
    return () => clearTimeout(timer);
  }, [draft, value]);
  return (
    <Input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      placeholder="Search campaigns and flows"
      aria-label="Search"
      className="h-8 w-56"
    />
  );
}
