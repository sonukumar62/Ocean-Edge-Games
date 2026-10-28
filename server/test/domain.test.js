import test from 'node:test';
import assert from 'node:assert/strict';
import { pointsForLevel, progressionForPoints, isRefundEligible } from '../src/domain/progression.js';
import { isTournamentVisible, statusForTournament } from '../src/domain/tournaments.js';

test('the configured level curve matches both required endpoints', () => {
  assert.equal(pointsForLevel(1), 0);
  assert.equal(pointsForLevel(2), 10);
  assert.equal(pointsForLevel(100), 10_000);
});

test('the progression thresholds are strictly increasing through level 100', () => {
  let prior = pointsForLevel(1);
  for (let level = 2; level <= 100; level += 1) {
    const threshold = pointsForLevel(level);
    assert.ok(threshold > prior, `Level ${level} should require more points than the prior level`);
    prior = threshold;
  }
});

test('level calculation returns current threshold and next-level gap', () => {
  assert.equal(progressionForPoints(9).level, 1);
  assert.equal(progressionForPoints(10).level, 2);
  assert.equal(progressionForPoints(10).pointsToNextLevel, pointsForLevel(3) - 10);
  assert.equal(progressionForPoints(10_000).level, 100);
  assert.equal(progressionForPoints(10_000).progress, 1);
});

test('refund eligibility closes at the configured 48 hour boundary', () => {
  const now = new Date('2026-10-27T00:00:00.000Z');
  assert.equal(isRefundEligible('2026-10-29T00:00:01.000Z', now), true);
  assert.equal(isRefundEligible('2026-10-29T00:00:00.000Z', now), false);
  assert.equal(isRefundEligible('2026-10-28T23:59:59.000Z', now), false);
});

test('a published tournament stays visible well before a future registration window', () => {
  const now = new Date('2026-10-28T00:00:00.000Z');
  const tournament = {
    status: 'published', visibility_mode: 'auto', visibility_deadline: '2027-02-01T00:00:00.000Z',
    registration_opens_at: '2027-01-01T00:00:00.000Z', registration_deadline: '2027-01-10T00:00:00.000Z',
    start_at: '2027-01-12T00:00:00.000Z', capacity: 16, registration_count: 0,
  };
  assert.equal(isTournamentVisible(tournament, now), true);
  assert.equal(statusForTournament(tournament, now), 'registration_not_open');
});

test('full tournaments stay visible and report Registration Full before other statuses', () => {
  const now = new Date('2026-10-28T00:00:00.000Z');
  const tournament = {
    status: 'published', visibility_mode: 'auto', visibility_deadline: '2027-02-01T00:00:00.000Z',
    registration_opens_at: '2027-01-01T00:00:00.000Z', registration_deadline: '2027-01-10T00:00:00.000Z',
    start_at: '2027-01-12T00:00:00.000Z', capacity: 16, registration_count: 16,
  };
  assert.equal(isTournamentVisible(tournament, now), true);
  assert.equal(statusForTournament(tournament, now), 'registration_full');
});

test('auto visibility ends at its deadline while explicit show and hide take precedence', () => {
  const now = new Date('2026-10-28T00:00:00.000Z');
  const event = { visibility_mode: 'auto', visibility_deadline: '2026-10-28T00:00:00.000Z' };
  assert.equal(isTournamentVisible(event, now), false);
  assert.equal(isTournamentVisible({ ...event, visibility_mode: 'show' }, now), true);
  assert.equal(isTournamentVisible({ ...event, visibility_mode: 'hide' }, now), false);
});
