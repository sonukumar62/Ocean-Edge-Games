-- Additive rank-specific cash-per-kill rewards and recorded match kills.
-- Existing reward rules and results are preserved; old results default to 0 kills.
alter table reward_rules
  add column if not exists per_kill_cash_paise integer not null default 0;

alter table reward_rules
  drop constraint if exists reward_rules_per_kill_cash_paise_check;
alter table reward_rules
  add constraint reward_rules_per_kill_cash_paise_check
  check (per_kill_cash_paise >= 0);

alter table match_results
  add column if not exists kills integer not null default 0;
alter table match_results
  drop constraint if exists match_results_kills_check;
alter table match_results
  add constraint match_results_kills_check check (kills >= 0);
