import { useEffect, useState } from 'react';

// Temporary public-only display adjustments. Deliberately memory-only and
// never included in API payloads or used for admin/registration records.
const fakeCounts = new Map();
const listeners = new Set();
export function setFakeRegistrationDisplayCount(tournamentId, value) {
  const count = Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0;
  if (!tournamentId) return;
  if (count) fakeCounts.set(tournamentId, count);
  else fakeCounts.delete(tournamentId);
  listeners.forEach(listener => listener());
}
export function getFakeRegistrationDisplayCount(tournamentId) {
  const value = fakeCounts.get(tournamentId);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
export function useFakeRegistrationDisplayCount(tournamentId) {
  const [, refresh] = useState(0);
  useEffect(() => { const update = () => refresh(value => value + 1); listeners.add(update); return () => listeners.delete(update); }, []);
  return getFakeRegistrationDisplayCount(tournamentId);
}
