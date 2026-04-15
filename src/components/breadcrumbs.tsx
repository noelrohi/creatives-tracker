"use client";

import { createContext, Fragment, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export type BreadcrumbItemData = {
  label: string;
  href?: string;
};

type Ctx = {
  items: BreadcrumbItemData[];
  setItems: (items: BreadcrumbItemData[]) => void;
};

const BreadcrumbsContext = createContext<Ctx | null>(null);

export function BreadcrumbsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<BreadcrumbItemData[]>([]);
  const value = useMemo(() => ({ items, setItems }), [items]);
  return <BreadcrumbsContext.Provider value={value}>{children}</BreadcrumbsContext.Provider>;
}

export function useBreadcrumbs(items: BreadcrumbItemData[]) {
  const ctx = useContext(BreadcrumbsContext);
  const key = JSON.stringify(items);
  useEffect(() => {
    if (!ctx) return;
    ctx.setItems(items);
    return () => ctx.setItems([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export function HeaderBreadcrumbs() {
  const ctx = useContext(BreadcrumbsContext);
  if (!ctx || ctx.items.length === 0) return null;
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {ctx.items.map((item, i) => {
          const isLast = i === ctx.items.length - 1;
          return (
            <Fragment key={`${item.label}-${i}`}>
              <BreadcrumbItem>
                {isLast || !item.href ? (
                  <BreadcrumbPage>{item.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={item.href}>{item.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast ? <BreadcrumbSeparator /> : null}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
