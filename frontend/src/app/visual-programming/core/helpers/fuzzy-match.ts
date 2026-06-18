/**
 * Fuzzy-match `query` against `target` (case-insensitive).
 *
 * Returns a numeric relevance score (higher = better match), or `null` when
 * there is no match at all.
 *
 * Scoring rationale:
 *  - Prefix match on the full string or any word boundary: large bonus.
 *  - Contiguous run of matched characters: bonus proportional to run length.
 *  - Each matched character contributes a base point.
 *
 * Empty query always returns 0 (every item matches with equal score).
 */
export function fuzzyMatch(query: string, target: string): number | null {
    if (query.length === 0) {
        return 0;
    }

    const q = query.toLowerCase();
    const t = target.toLowerCase();

    // Fast-path: exact prefix match.
    if (t.startsWith(q)) {
        return 1000 + q.length * 10;
    }

    // Walk through the target finding all query characters in order.
    let queryIndex = 0;
    let score = 0;
    let consecutiveRun = 0;
    let prevMatchedAt = -2;

    for (let targetIndex = 0; targetIndex < t.length && queryIndex < q.length; targetIndex++) {
        if (t[targetIndex] === q[queryIndex]) {
            score += 10;

            // Bonus for consecutive characters.
            if (targetIndex === prevMatchedAt + 1) {
                consecutiveRun++;
                score += consecutiveRun * 5;
            } else {
                consecutiveRun = 0;
            }

            // Bonus for word-boundary match (match starts at a space or '-' or after a space).
            if (targetIndex === 0 || t[targetIndex - 1] === ' ' || t[targetIndex - 1] === '-') {
                score += 30;
            }

            prevMatchedAt = targetIndex;
            queryIndex++;
        }
    }

    // All query characters must be found.
    if (queryIndex < q.length) {
        return null;
    }

    return score;
}
