export type CreativeHealth = "healthy" | "warning" | "critical";

export type HealthVerdict = {
  health: CreativeHealth | null;
  reasons: string[];
};

function fmtMoney(n: number): string {
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

/**
 * Compute ad/creative health plus the reasons each signal fired. `reasons` are
 * short human-readable strings (e.g. "CTR dropped 28% vs baseline"), safe to
 * surface in a tooltip.
 */
export function computeHealth(opts: {
  roas: number | null;
  spend: number | null;
  conversions: number | null;
  status?: string | null;
  format?: string | null;
  recentConversions?: number | null;
  recentCtr?: number | null;
  avgCtr?: number | null;
  recentCpc?: number | null;
  avgCpc?: number | null;
  frequency?: number | null;
  recentHookRate?: number | null;
  priorHookRate?: number | null;
  recentCpa?: number | null;
  avgCpa?: number | null;
  thumbstopRatio?: number | null;
}): HealthVerdict {
  const { roas, spend, conversions, status } = opts;

  if (spend == null || spend < 25) return { health: null, reasons: [] };

  // Active ad with meaningful spend but zero conversions. Threshold matches the
  // per-ad bleeder rule used by the dashboard's Needs Attention panel and the
  // CSV's flag_disable_candidate so all three agree on what's actionable.
  if (status === "active" && (conversions == null || conversions === 0) && spend >= 25) {
    return {
      health: "critical",
      reasons: [`No conversions on ${fmtMoney(spend)} spent`],
    };
  }

  const reasons: string[] = [];
  let warningSignals = 0;
  let criticalSignals = 0;
  let hasTrendData = false;

  const { recentCtr, avgCtr } = opts;
  if (recentCtr != null && avgCtr != null && avgCtr > 0) {
    hasTrendData = true;
    const drop = (avgCtr - recentCtr) / avgCtr;
    if (drop >= 0.25) {
      criticalSignals++;
      reasons.push(`CTR dropped ${Math.round(drop * 100)}% vs baseline`);
    } else if (drop >= 0.1) {
      warningSignals++;
      reasons.push(`CTR dropped ${Math.round(drop * 100)}% vs baseline`);
    }
  }
  if (recentCtr != null && recentCtr < 1) {
    warningSignals++;
    reasons.push(`CTR below 1% (${recentCtr.toFixed(2)}%)`);
  }

  const { recentCpc, avgCpc } = opts;
  if (recentCpc != null && avgCpc != null && avgCpc > 0) {
    hasTrendData = true;
    const rise = (recentCpc - avgCpc) / avgCpc;
    if (rise >= 0.3) {
      criticalSignals++;
      reasons.push(`CPC rose ${Math.round(rise * 100)}% vs baseline`);
    } else if (rise >= 0.15) {
      warningSignals++;
      reasons.push(`CPC rose ${Math.round(rise * 100)}% vs baseline`);
    }
  }

  const { frequency } = opts;
  if (frequency != null) {
    hasTrendData = true;
    if (frequency > 4) {
      criticalSignals++;
      reasons.push(`Frequency at ${frequency.toFixed(1)} (audience fatigued)`);
    } else if (frequency > 2.5) {
      warningSignals++;
      reasons.push(`Frequency at ${frequency.toFixed(1)} (approaching fatigue)`);
    }
  }

  // UGC is a video-format subcategory in this codebase — treat the same.
  const isVideo = opts.format === "video" || opts.format === "ugc";
  const { recentHookRate, priorHookRate } = opts;
  if (isVideo && recentHookRate != null && priorHookRate != null && priorHookRate > 0) {
    hasTrendData = true;
    const drop = (priorHookRate - recentHookRate) / priorHookRate;
    if (drop >= 0.3) {
      criticalSignals++;
      reasons.push(`Hook rate dropped ${Math.round(drop * 100)}%`);
    } else if (drop >= 0.15) {
      warningSignals++;
      reasons.push(`Hook rate dropped ${Math.round(drop * 100)}%`);
    }
  }

  const { thumbstopRatio } = opts;
  if (isVideo && thumbstopRatio != null && thumbstopRatio > 0 && thumbstopRatio < 0.25) {
    warningSignals++;
    reasons.push(`Thumbstop ratio below 25% (${Math.round(thumbstopRatio * 100)}%)`);
  }

  // CPA trend requires a meaningful recent conversion count. A recent CPA
  // computed from 1-2 conversions is too noisy to trust.
  const { recentCpa, avgCpa, recentConversions } = opts;
  const cpaHasEvidence = recentConversions != null && recentConversions >= 3;
  if (cpaHasEvidence && recentCpa != null && avgCpa != null && avgCpa > 0) {
    hasTrendData = true;
    const rise = (recentCpa - avgCpa) / avgCpa;
    if (rise >= 0.3) {
      criticalSignals++;
      reasons.push(`CPA up ${Math.round(rise * 100)}% vs baseline`);
    } else if (rise >= 0.15) {
      warningSignals++;
      reasons.push(`CPA up ${Math.round(rise * 100)}% vs baseline`);
    }
  }

  if (hasTrendData) {
    // Profitability gate: if the window ROAS is still breakeven or better, a
    // single critical signal is a heads-up, not a fire. Require 2+ critical
    // signals (or warning compound) before calling it critical.
    const profitable = roas != null && roas >= 1;
    if (profitable) {
      if (criticalSignals >= 2 || (criticalSignals >= 1 && warningSignals >= 2)) {
        return { health: "critical", reasons };
      }
      if (criticalSignals > 0 || warningSignals > 0) {
        return { health: "warning", reasons };
      }
      return { health: "healthy", reasons: [] };
    }
    if (criticalSignals > 0 || warningSignals >= 2) return { health: "critical", reasons };
    if (warningSignals > 0) return { health: "warning", reasons };
    // No trend signals fired, but the ad is unprofitable — never call this
    // "healthy". Fall through to the ROAS-based verdict below so a 0-conv or
    // sub-1x ROAS ad gets labeled the way a media buyer would label it.
  }

  // Fallback: ROAS-based. Also catches the no-trend-signal-but-unprofitable
  // case from the trend branch above.
  if (roas == null) return { health: null, reasons: [] };
  if (roas < 0.5) {
    return {
      health: "critical",
      reasons: [`ROAS ${roas.toFixed(2)}x on ${fmtMoney(spend)} spent`],
    };
  }
  if (roas < 1) {
    return {
      health: "warning",
      reasons: [`ROAS ${roas.toFixed(2)}x on ${fmtMoney(spend)} spent`],
    };
  }
  return { health: "healthy", reasons: [] };
}

/**
 * Roll up per-ad health into a creative-level verdict, weighted by spend.
 *
 * Only active ads contribute. A paused ad's bad performance is historical —
 * the action (pause) already happened, so surfacing it on the rollup would
 * push the creative to "Critical" with nothing left to act on.
 *
 * The rolled-up `reasons` explain which ads contributed — e.g. "2 of 3 ads
 * critical (85% of spend) — No conversions on $320 spent · ROAS 0.3x".
 */
export function rollupCreativeHealth(
  adRows: Array<{
    spend: number | null;
    health: CreativeHealth | null;
    reasons?: string[];
    status?: string | null;
  }>,
): HealthVerdict {
  const scored = adRows.filter(
    (r) =>
      r.health != null
      && r.spend != null
      && r.spend > 0
      && (r.status == null || r.status === "active"),
  ) as Array<{ spend: number; health: CreativeHealth; reasons?: string[] }>;
  if (scored.length === 0) return { health: null, reasons: [] };

  const total = scored.reduce((acc, r) => acc + r.spend, 0);
  if (total <= 0) return { health: null, reasons: [] };

  const criticalAds = scored.filter((r) => r.health === "critical");
  const warningAds = scored.filter((r) => r.health === "warning");
  const criticalSpend = criticalAds.reduce((acc, r) => acc + r.spend, 0);
  const warningOrWorseSpend = criticalSpend + warningAds.reduce((acc, r) => acc + r.spend, 0);

  const criticalShare = criticalSpend / total;
  const warningShare = warningOrWorseSpend / total;

  if (criticalShare >= 0.5) {
    const adReasons = criticalAds
      .flatMap((a) => a.reasons ?? [])
      .filter((r, i, self) => self.indexOf(r) === i)
      .slice(0, 3);
    const header = `${criticalAds.length} of ${scored.length} ad${scored.length === 1 ? "" : "s"} critical (${Math.round(criticalShare * 100)}% of spend)`;
    return { health: "critical", reasons: [header, ...adReasons] };
  }
  if (warningShare >= 0.5) {
    const flagged = [...criticalAds, ...warningAds];
    const adReasons = flagged
      .flatMap((a) => a.reasons ?? [])
      .filter((r, i, self) => self.indexOf(r) === i)
      .slice(0, 3);
    const header = `${flagged.length} of ${scored.length} ad${scored.length === 1 ? "" : "s"} flagged (${Math.round(warningShare * 100)}% of spend)`;
    return { health: "warning", reasons: [header, ...adReasons] };
  }
  return { health: "healthy", reasons: [] };
}
