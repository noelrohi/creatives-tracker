export type ClaimsConstraintInput = {
  prohibitedClaims: string[];
  requiredDisclaimers: string[];
};

export type ClaimMatch = {
  claim: string;
  index: number;
};

export function buildClaimsConstraint({
  prohibitedClaims,
  requiredDisclaimers,
}: ClaimsConstraintInput) {
  const prohibited = prohibitedClaims.map((claim) => claim.trim()).filter(Boolean);
  const required = requiredDisclaimers
    .map((disclaimer) => disclaimer.trim())
    .filter(Boolean);

  if (prohibited.length === 0 && required.length === 0) return "";

  return [
    "CLAIMS GUARDRAIL (hard constraints):",
    ...prohibited.map((claim) => `- Never state or imply: ${claim}`),
    ...required.map(
      (disclaimer) =>
        `- Required disclaimers that must accompany relevant claims: ${disclaimer}`,
    ),
    "Follow these constraints exactly in every concept and line of copy.",
  ].join("\n");
}

function normalizeClaimsText(value: string) {
  return value
    .toLowerCase()
    .replace(/[.,!?\-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function scanTextForClaims(
  text: string,
  prohibitedClaims: string[],
): ClaimMatch[] {
  const normalizedText = normalizeClaimsText(text);

  return prohibitedClaims.flatMap((claim) => {
    const normalizedClaim = normalizeClaimsText(claim);
    if (!normalizedClaim) return [];

    const index = normalizedText.indexOf(normalizedClaim);
    return index === -1 ? [] : [{ claim, index }];
  });
}
