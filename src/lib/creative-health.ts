export type CreativeHealth = "healthy" | "warning" | "critical";

/**
 * Compute creative health using combined fatigue detection signals.
 *
 * GREEN (Healthy) — Growth phase, engaging effectively:
 *   - CTR >= 1%, thumbstop ratio >= 30%, frequency < 2.0
 *   - CPA at or below avg, ROAS strong
 *   - No declining trend signals
 *
 * YELLOW (Warning) — Approaching fatigue, trends declining:
 *   Leading indicators:
 *   - CTR dropping 10-20% over 3 days (hook weakening)
 *   - Frequency > 2.5 (cold) or > 4.0 (retargeting)
 *   - CPC rising 15%+ (Meta charging more for worse attention)
 *   - Hook rate / thumbstop ratio declining 15%+
 *
 * RED (Critical) — Burning budget, hurting account health:
 *   - CPA exceeds avg by 15-30%+
 *   - CTR dropped 25%+
 *   - CPC risen 30%+
 *   - Frequency > 4.0
 *   - Multiple warning signals compound to critical
 *
 * Falls back to ROAS-based assessment when trend data is unavailable.
 */
export function computeHealth(opts: {
  roas: number | null;
  spend: number | null;
  conversions: number | null;
  status?: string | null;
  // Trend signals
  recentCtr?: number | null;
  avgCtr?: number | null;
  recentCpc?: number | null;
  avgCpc?: number | null;
  frequency?: number | null;
  recentHookRate?: number | null;
  priorHookRate?: number | null;
  // CPA-based detection
  recentCpa?: number | null;
  avgCpa?: number | null;
  // Absolute metrics
  thumbstopRatio?: number | null;
}): CreativeHealth | null {
  const { roas, spend, conversions, status } = opts;

  // Not enough data to evaluate
  if (spend == null || spend < 50) return null;

  // Active ad with meaningful spend but zero conversions
  if (
    status === "active" &&
    (conversions == null || conversions === 0) &&
    spend >= 100
  ) {
    return "critical";
  }

  let warningSignals = 0;
  let criticalSignals = 0;
  let hasTrendData = false;

  // --- 1. CTR trajectory ---
  // 10-20% drop = warning, 25%+ drop = critical
  const { recentCtr, avgCtr } = opts;
  if (recentCtr != null && avgCtr != null && avgCtr > 0) {
    hasTrendData = true;
    const ctrDrop = (avgCtr - recentCtr) / avgCtr;
    if (ctrDrop >= 0.25) criticalSignals++;
    else if (ctrDrop >= 0.1) warningSignals++;
  }

  // Absolute CTR floor: below 1% is a weak signal
  if (recentCtr != null && recentCtr < 1) {
    warningSignals++;
  }

  // --- 2. CPC inflation ---
  // 15%+ rise = warning, 30%+ rise = critical
  const { recentCpc, avgCpc } = opts;
  if (recentCpc != null && avgCpc != null && avgCpc > 0) {
    hasTrendData = true;
    const cpcRise = (recentCpc - avgCpc) / avgCpc;
    if (cpcRise >= 0.3) criticalSignals++;
    else if (cpcRise >= 0.15) warningSignals++;
  }

  // --- 3. Frequency ---
  // >2.5 = warning (cold audiences), >4.0 = critical
  const { frequency } = opts;
  if (frequency != null) {
    hasTrendData = true;
    if (frequency > 4) criticalSignals++;
    else if (frequency > 2.5) warningSignals++;
  }

  // --- 4. Hook rate / thumbstop ratio decay (video) ---
  // 15%+ drop = warning, 30%+ drop = critical
  const { recentHookRate, priorHookRate } = opts;
  if (recentHookRate != null && priorHookRate != null && priorHookRate > 0) {
    hasTrendData = true;
    const hookDrop = (priorHookRate - recentHookRate) / priorHookRate;
    if (hookDrop >= 0.3) criticalSignals++;
    else if (hookDrop >= 0.15) warningSignals++;
  }

  // Absolute thumbstop ratio: below 25% is concerning
  const { thumbstopRatio } = opts;
  if (thumbstopRatio != null && thumbstopRatio < 0.25) {
    warningSignals++;
  }

  // --- 5. CPA exceeding baseline ---
  // 15%+ above avg = warning, 30%+ = critical
  const { recentCpa, avgCpa } = opts;
  if (recentCpa != null && avgCpa != null && avgCpa > 0) {
    hasTrendData = true;
    const cpaRise = (recentCpa - avgCpa) / avgCpa;
    if (cpaRise >= 0.3) criticalSignals++;
    else if (cpaRise >= 0.15) warningSignals++;
  }

  // If we have trend data, use signal-based health
  if (hasTrendData) {
    // Any critical signal or 2+ warning signals = critical
    if (criticalSignals > 0 || warningSignals >= 2) return "critical";
    if (warningSignals > 0) return "warning";
    return "healthy";
  }

  // Fallback: ROAS-based when no trend data available
  if (roas == null) return null;
  if (roas < 0.5) return "critical";
  if (roas < 1) return "warning";
  return "healthy";
}
