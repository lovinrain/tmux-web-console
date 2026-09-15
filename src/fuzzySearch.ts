const PRIMARY_FIELD_SCORE_BONUS = 2_200;

export function normalizeFuzzyText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fuzzyTokenScore(token: string, candidate: string): number | null {
  if (!token || !candidate) return null;
  if (candidate === token) return 5_000;
  if (candidate.startsWith(token)) return 4_000 - (candidate.length - token.length);

  const substringIndex = candidate.indexOf(token);
  if (substringIndex >= 0) {
    const boundaryBonus = substringIndex === 0 || candidate[substringIndex - 1] === " "
      ? 300
      : 0;
    return 3_000 + boundaryBonus - substringIndex * 3 - (candidate.length - token.length);
  }

  let tokenIndex = 0;
  let previousMatch = -2;
  let score = 1_000;
  for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex += 1) {
    if (candidate[candidateIndex] !== token[tokenIndex]) continue;
    score += candidateIndex === previousMatch + 1 ? 45 : 12;
    if (candidateIndex === 0 || candidate[candidateIndex - 1] === " ") score += 35;
    score -= Math.max(0, candidateIndex - previousMatch - 1) * 2;
    previousMatch = candidateIndex;
    tokenIndex += 1;
    if (tokenIndex === token.length) {
      return score - Math.max(0, candidate.length - token.length);
    }
  }
  return null;
}

export function fuzzyFieldsScore(
  query: string,
  fields: readonly string[],
): number | null {
  const tokens = normalizeFuzzyText(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return 0;
  const normalizedFields = fields.map(normalizeFuzzyText).filter(Boolean);
  let score = 0;

  for (const token of tokens) {
    let bestScore: number | null = null;
    normalizedFields.forEach((field, fieldIndex) => {
      const fieldScore = fuzzyTokenScore(token, field);
      if (fieldScore === null) return;
      const weightedScore = fieldScore
        + (fieldIndex === 0 ? PRIMARY_FIELD_SCORE_BONUS : 0);
      bestScore = bestScore === null ? weightedScore : Math.max(bestScore, weightedScore);
    });
    if (bestScore === null) return null;
    score += bestScore;
  }
  return score;
}
