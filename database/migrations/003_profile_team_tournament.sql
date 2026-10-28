-- Expand profile, team, tournament visibility, and registration features.
create table if not exists player_username_changes (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  old_username text not null,
  new_username text not null,
  changed_at timestamptz not null default now()
);
create index if not exists player_username_changes_window_idx
  on player_username_changes(user_id, changed_at desc);

alter table teams add column if not exists logo_storage_path text;
create table if not exists team_guest_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  display_name text not null check(length(display_name) between 2 and 80),
  external_handle text not null check(length(external_handle) between 2 and 48),
  created_at timestamptz not null default now()
);
create unique index if not exists team_guest_handle_idx
  on team_guest_members(team_id, lower(external_handle));

alter table tournaments add column if not exists registration_opens_at timestamptz;
alter table tournaments add column if not exists visibility_deadline timestamptz;
alter table tournaments add column if not exists visibility_mode text not null default 'auto';
alter table tournaments add column if not exists artwork_path text;
update tournaments set registration_opens_at=coalesce(registration_opens_at,published_at,created_at,now());
update tournaments set visibility_deadline=coalesce(visibility_deadline,start_at);
-- Existing published events keep their prior visibility; admins can move them to Auto later.
update tournaments set visibility_mode='show' where status='published' and visibility_mode='auto';
alter table tournaments alter column registration_opens_at set default now();
alter table tournaments alter column registration_opens_at set not null;
alter table tournaments drop constraint if exists tournaments_visibility_mode_check;
alter table tournaments add constraint tournaments_visibility_mode_check
  check(visibility_mode in ('auto','show','hide'));
create index if not exists tournaments_visibility_idx
  on tournaments(status,visibility_mode,visibility_deadline);

alter table tournament_registrations add column if not exists registration_number bigint;
with numbered as (
  select id,row_number() over(order by created_at,id) as n
  from tournament_registrations where registration_number is null
)
update tournament_registrations r set registration_number=numbered.n
from numbered where r.id=numbered.id;
create unique index if not exists tournament_registrations_number_idx
  on tournament_registrations(registration_number);
alter table tournament_registrations alter column registration_number set not null;
create table if not exists registration_counters (
  singleton_id smallint primary key default 1 check(singleton_id = 1),
  last_number bigint not null default 0
);
insert into registration_counters(singleton_id,last_number)
select 1,coalesce(max(registration_number),0) from tournament_registrations
on conflict(singleton_id) do update
set last_number=greatest(registration_counters.last_number,excluded.last_number);
