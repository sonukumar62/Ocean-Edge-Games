export function isTournamentVisible(row, now = new Date()) {
  if (row.visibility_mode === 'hide') return false;
  if (row.visibility_mode === 'show') return true;
  const deadline = row.visibility_deadline ? new Date(row.visibility_deadline).getTime() : null;
  return deadline === null || deadline > now.getTime();
}

export function statusForTournament(row, now = new Date()) {
  if (row.status !== 'published') return row.status;
  if (row.capacity && Number(row.registration_count) >= Number(row.capacity)) return 'registration_full';
  if (row.registration_opens_at && new Date(row.registration_opens_at).getTime() > now.getTime()) return 'registration_not_open';
  if (new Date(row.start_at).getTime() <= now.getTime()) return 'started';
  if (new Date(row.registration_deadline).getTime() <= now.getTime()) return 'registration_closed';
  return 'registration_open';
}
