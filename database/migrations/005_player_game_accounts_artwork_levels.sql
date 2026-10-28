-- Player game identities and level-gated profile artwork.
-- Additive changes preserve existing profiles and approved artwork.
create table if not exists player_game_accounts (
  user_id uuid not null references users(id) on delete cascade,
  game_id uuid not null references games(id) on delete cascade,
  game_identifier text not null check (length(trim(game_identifier)) between 2 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
create unique index if not exists player_game_accounts_identifier_idx
  on player_game_accounts(game_id, lower(game_identifier));
create index if not exists player_game_accounts_game_idx
  on player_game_accounts(game_id, user_id);

alter table approved_profile_assets
  add column if not exists min_level smallint not null default 1;
alter table approved_profile_assets
  drop constraint if exists approved_profile_assets_min_level_check;
alter table approved_profile_assets
  add constraint approved_profile_assets_min_level_check check (min_level between 1 and 100);
