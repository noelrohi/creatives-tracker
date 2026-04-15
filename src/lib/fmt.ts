export function fmtMoney(val: unknown) {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseFloat(val) : Number(val);
  if (isNaN(n)) return "—";
  return `$${n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2)}`;
}

export function fmtRoas(val: unknown) {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseFloat(val) : Number(val);
  if (isNaN(n)) return "—";
  return `${n.toFixed(2)}x`;
}

export function fmtPct(val: unknown) {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseFloat(val) : Number(val);
  if (isNaN(n)) return "—";
  return `${n.toFixed(2)}%`;
}

export function fmtNum(val: unknown) {
  if (val == null || val === "") return "—";
  const n = typeof val === "string" ? parseInt(val, 10) : Number(val);
  if (isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}
