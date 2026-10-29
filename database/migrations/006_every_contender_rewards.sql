-- Placement 0 is the shared reward tier for any participant not assigned
-- a numbered finishing place. Existing positive placements remain unchanged.
alter table match_results drop constraint if exists match_results_placement_check;
alter table match_results add constraint match_results_placement_check check (placement >= 0);

alter table reward_rules drop constraint if exists reward_rules_placement_check;
alter table reward_rules add constraint reward_rules_placement_check check (placement >= 0);
