-- Add administrator-curated profile banners to existing installations.
alter table player_profiles add column if not exists banner_asset_id uuid;

alter table approved_profile_assets drop constraint if exists approved_profile_assets_asset_type_check;
alter table approved_profile_assets
  add constraint approved_profile_assets_asset_type_check
  check (asset_type in ('avatar', 'background', 'banner'));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'player_banner_asset_fk'
      and conrelid = 'player_profiles'::regclass
  ) then
    alter table player_profiles
      add constraint player_banner_asset_fk
      foreign key (banner_asset_id) references approved_profile_assets(id) on delete set null;
  end if;
end $$;

create index if not exists player_profiles_banner_asset_idx
  on player_profiles(banner_asset_id) where banner_asset_id is not null;
