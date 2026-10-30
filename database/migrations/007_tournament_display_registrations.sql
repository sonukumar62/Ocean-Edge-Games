-- Public display adjustment, stored separately from real registrations.
alter table tournaments
  add column if not exists b_registration integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'tournaments'::regclass
      and conname = 'tournaments_b_registration_check'
  ) then
    alter table tournaments add constraint tournaments_b_registration_check
      check (b_registration >= 0);
  end if;
end $$;
