export function buildWoundStateHints(labels, bodyType) {
  const body = normalizeBodyType(bodyType);
  return labels.map((label, index) => {
    const woundLevel = index + 1;
    const stunPenalty = woundLevel <= 1 ? 0 : woundLevel - 1;
    const stunThreshold = Math.max(1, body - stunPenalty);
    const hint = stunPenalty > 0
      ? `Stun Save: d10 ≤ ${stunThreshold} (BODY ${body} - ${stunPenalty})`
      : `Stun Save: d10 ≤ BODY ${body}`;
    return {
      label,
      stunPenalty,
      stunThreshold,
      hint
    };
  });
}

function normalizeBodyType(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 1;
}
