// Central progression curve: level 2 starts at 10 points and level 100 at 10,000.
// A power curve (exponent 1.2) creates gradual early levels and a longer endgame.
export function pointsForLevel(level) {
  if (!Number.isInteger(level) || level < 1 || level > 100) throw new RangeError('Level must be between 1 and 100');
  if (level === 1) return 0;
  if (level === 100) return 10_000;
  const progress = (level - 2) / 98;
  return 10 + Math.round(9_990 * progress ** 1.2);
}

export function progressionForPoints(points) {
  const total = Math.max(0, Number.isFinite(Number(points)) ? Number(points) : 0);
  let level = 1;
  for (let candidate = 2; candidate <= 100; candidate += 1) {
    if (total < pointsForLevel(candidate)) break;
    level = candidate;
  }
  const currentThreshold = pointsForLevel(level);
  const nextThreshold = level < 100 ? pointsForLevel(level + 1) : currentThreshold;
  return {
    level,
    points: total,
    currentThreshold,
    nextThreshold,
    pointsToNextLevel: Math.max(0, nextThreshold - total),
    progress: level >= 100 ? 1 : Math.min(1, (total - currentThreshold) / (nextThreshold - currentThreshold)),
  };
}

export function isRefundEligible(startAt, now = new Date()) {
  const start = new Date(startAt);
  return Number.isFinite(start.getTime()) && start.getTime() - now.getTime() > 48 * 60 * 60 * 1000;
}
