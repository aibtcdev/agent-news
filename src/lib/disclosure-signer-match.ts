/**
 * Detect when a signal disclosure names a different correspondent than the signer (#850).
 * Option A: warn, still accept.
 */

export interface CorrespondentRef {
  btcAddress: string;
  displayName: string | null;
}

/**
 * Returns names of *other* known correspondents that appear in disclosure text.
 * Matching is case-insensitive on displayName substrings (first 80 chars of disclosure).
 */
export function findDisclosureSignerMismatches(input: {
  disclosure: string;
  signerBtcAddress: string;
  signerDisplayName: string | null;
  knownCorrespondents: CorrespondentRef[];
}): string[] {
  const head = (input.disclosure || "").slice(0, 80);
  if (!head.trim()) return [];

  const lower = head.toLowerCase();
  const signerName = (input.signerDisplayName || "").trim().toLowerCase();
  const mismatches: string[] = [];

  for (const c of input.knownCorrespondents) {
    const name = (c.displayName || "").trim();
    if (!name || name.length < 3) continue;
    if (c.btcAddress === input.signerBtcAddress) continue;
    const n = name.toLowerCase();
    // Avoid flagging if signer name is longer and contains this name as subset incorrectly —
    // require whole-name token presence.
    if (lower.includes(n) && n !== signerName) {
      mismatches.push(name);
    }
  }
  return [...new Set(mismatches)];
}

export function buildDisclosureMismatchWarning(mismatchedNames: string[], signerLabel: string): string {
  if (!mismatchedNames.length) return "";
  return (
    `disclosure_signer_mismatch: filing signed by ${signerLabel} but disclosure names ` +
    mismatchedNames.join(", ")
  );
}
