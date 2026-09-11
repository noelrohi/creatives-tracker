"use client";

import { useQueryStates } from "nuqs";
import {
  LEDGER_URL_PARSERS,
  ledgerStateHelpers,
} from "@/components/blocks/attribution/klaviyo/ledger/ledger-url-state";

/** The campaigns page's URL state: the ledger's params and nothing else. */
export function useLedgerPageState() {
  const [state, setState] = useQueryStates(LEDGER_URL_PARSERS, {
    history: "replace",
  });
  return { state, setState, ...ledgerStateHelpers(state, setState) };
}
