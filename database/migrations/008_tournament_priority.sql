-- Admin-configurable ordering priority. Existing tournaments default to the standard level (0).
alter table tournaments
  add column if not exists priority_level integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'tournaments'::regclass
      and conname = 'tournaments_priority_level_check'
  ) then
    alter table tournaments add constraint tournaments_priority_level_check
      check (priority_level >= 0);
  end if;
end $$;
