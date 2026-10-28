-- Ocean Edge Games initial schema. Apply once to the Supabase PostgreSQL project.
create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  role text not null default 'player' check (role in ('player','admin')),
  status text not null default 'active' check (status in ('active','suspended','blocked')),
  suspended_until timestamptz,
  email_verified_at timestamptz,
  manual_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists users_status_idx on users(status, created_at desc);

create table if not exists player_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  full_name text not null,
  username text not null unique,
  age smallint not null check (age >= 13 and age <= 120),
  phone text not null,
  upi_id text,
  avatar_asset_id uuid,
  background_asset_id uuid,
  banner_asset_id uuid,
  bio text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists player_profiles_username_idx on player_profiles(lower(username));
create unique index if not exists player_profiles_username_casefold_idx on player_profiles(lower(username));
create table if not exists player_username_changes (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  old_username text not null,
  new_username text not null,
  changed_at timestamptz not null default now()
);
create index if not exists player_username_changes_window_idx on player_username_changes(user_id, changed_at desc);

create table if not exists pending_registrations (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  otp_hash text not null,
  expires_at timestamptz not null,
  resend_after timestamptz not null,
  attempts integer not null default 0,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists password_reset_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists password_reset_user_idx on password_reset_challenges(user_id, expires_at desc);

-- express-session / connect-pg-simple store (no client-visible session secrets).
create table if not exists sessions (
  sid varchar primary key,
  sess json not null,
  expire timestamptz not null
);
create index if not exists sessions_expire_idx on sessions(expire);

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  description text not null default '',
  artwork_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists game_formats (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete restrict,
  name text not null,
  participant_count integer not null check (participant_count >= 1 and participant_count <= 100),
  scoring_rule text not null default 'sum',
  active boolean not null default true,
  unique(game_id, name)
);

create table if not exists tournaments (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete restrict,
  format_id uuid not null references game_formats(id) on delete restrict,
  name text not null,
  slug text not null unique,
  description text not null default '',
  rules text not null default '',
  artwork_url text,
  status text not null default 'draft' check(status in ('draft','published','registration_closed','ongoing','completed','cancelled','archived')),
  start_at timestamptz not null,
  registration_opens_at timestamptz not null default now(),
  registration_deadline timestamptz not null,
  visibility_deadline timestamptz,
  visibility_mode text not null default 'auto' check(visibility_mode in ('auto','show','hide')),
  artwork_path text,
  timezone text not null default 'Asia/Kolkata',
  capacity integer check(capacity is null or capacity > 0),
  entry_fee_paise integer not null default 0 check(entry_fee_paise >= 0),
  currency text not null default 'INR' check(currency = 'INR'),
  prizes jsonb not null default '[]'::jsonb,
  reward_config jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (registration_deadline <= start_at)
);
create index if not exists tournaments_public_idx on tournaments(status, start_at);
create index if not exists tournaments_game_idx on tournaments(game_id, status, start_at);

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete restrict,
  format_id uuid not null references game_formats(id) on delete restrict,
  name text not null,
  leader_user_id uuid references users(id) on delete set null,
  created_by uuid not null references users(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table teams add column if not exists logo_storage_path text;
create unique index if not exists teams_name_game_idx on teams(game_id, lower(name));
create table if not exists team_members (
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null references users(id) on delete restrict,
  role text not null default 'member' check(role in ('leader','member')),
  joined_at timestamptz not null default now(),
  primary key(team_id, user_id),
  unique(user_id, team_id)
);
create index if not exists team_members_user_idx on team_members(user_id);
create table if not exists team_guest_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  display_name text not null check(length(display_name) between 2 and 80),
  external_handle text not null check(length(external_handle) between 2 and 48),
  created_at timestamptz not null default now()
);
create unique index if not exists team_guest_handle_idx on team_guest_members(team_id, lower(external_handle));
create table if not exists team_invitations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  invited_user_id uuid not null references users(id) on delete cascade,
  invited_by uuid not null references users(id) on delete restrict,
  status text not null default 'pending' check(status in ('pending','accepted','declined','cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique(team_id, invited_user_id)
);

create table if not exists tournament_registrations (
  id uuid primary key default gen_random_uuid(),
  registration_number bigint not null unique,
  reference text not null unique,
  tournament_id uuid not null references tournaments(id) on delete restrict,
  player_id uuid references users(id) on delete restrict,
  team_id uuid references teams(id) on delete restrict,
  status text not null default 'pending_payment' check(status in ('pending_payment','confirmed','cancelled','waitlisted','refunded')),
  payment_status text not null default 'unpaid' check(payment_status in ('unpaid','pending','paid','failed','refunded','not_required')),
  reserved_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((player_id is null) <> (team_id is null)),
  unique(tournament_id, player_id),
  unique(tournament_id, team_id)
);
create table if not exists registration_counters (
  singleton_id smallint primary key default 1 check(singleton_id = 1),
  last_number bigint not null default 0
);
insert into registration_counters(singleton_id,last_number) values(1,0) on conflict(singleton_id) do nothing;
create index if not exists registrations_tournament_idx on tournament_registrations(tournament_id, status);
create index if not exists registrations_player_idx on tournament_registrations(player_id, created_at desc);
create table if not exists registration_participants (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references tournament_registrations(id) on delete cascade,
  user_id uuid references users(id) on delete restrict,
  external_name text,
  external_handle text,
  created_at timestamptz not null default now(),
  check ((user_id is null) <> (external_name is null)),
  unique(registration_id, user_id),
  unique(registration_id, external_handle)
);

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete restrict,
  title text not null,
  status text not null default 'scheduled' check(status in ('scheduled','ongoing','completed','cancelled')),
  scheduled_at timestamptz not null,
  room_id text,
  room_password text,
  room_releases_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists matches_schedule_idx on matches(scheduled_at, status);
create table if not exists match_participants (
  match_id uuid not null references matches(id) on delete cascade,
  registration_id uuid not null references tournament_registrations(id) on delete restrict,
  primary key(match_id, registration_id)
);
create table if not exists match_results (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches(id) on delete restrict,
  registration_id uuid not null references tournament_registrations(id) on delete restrict,
  placement integer not null check(placement > 0),
  finalized_by uuid references users(id) on delete set null,
  finalized_at timestamptz,
  correction_of uuid references match_results(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(match_id, registration_id, correction_of)
);
create unique index if not exists match_results_original_idx on match_results(match_id, registration_id) where correction_of is null;
create table if not exists reward_rules (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  placement integer not null check(placement > 0),
  og_points integer not null default 0 check(og_points >= 0),
  xp_points integer not null default 0 check(xp_points >= 0),
  cash_paise integer not null default 0 check(cash_paise >= 0),
  unique(tournament_id, placement)
);
create table if not exists reward_transactions (
  id uuid primary key default gen_random_uuid(),
  result_id uuid not null references match_results(id) on delete restrict,
  user_id uuid references users(id) on delete restrict,
  team_id uuid references teams(id) on delete restrict,
  og_points integer not null default 0,
  xp_points integer not null default 0,
  cash_paise integer not null default 0,
  status text not null default 'pending' check(status in ('pending','confirmed','paid','reversed')),
  created_at timestamptz not null default now(),
  check ((user_id is null) <> (team_id is null)),
  unique(result_id, user_id), unique(result_id, team_id)
);
create table if not exists og_points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete restrict,
  team_id uuid references teams(id) on delete restrict,
  result_id uuid references match_results(id) on delete restrict,
  points integer not null,
  reason text not null,
  idempotency_key text not null unique,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((user_id is null) <> (team_id is null))
);
create index if not exists og_ledger_user_idx on og_points_ledger(user_id, created_at desc);
create table if not exists xp_points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  points integer not null,
  reason text not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists cash_reward_records (
  id uuid primary key default gen_random_uuid(),
  reward_transaction_id uuid not null unique references reward_transactions(id) on delete restrict,
  user_id uuid references users(id) on delete restrict,
  team_id uuid references teams(id) on delete restrict,
  amount_paise integer not null check(amount_paise >= 0),
  status text not null default 'pending' check(status in ('pending','confirmed','paid','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references tournament_registrations(id) on delete restrict,
  provider text not null default 'razorpay',
  order_id text unique,
  payment_id text unique,
  amount_paise integer not null check(amount_paise > 0),
  currency text not null default 'INR',
  status text not null default 'created' check(status in ('created','authorized','captured','failed','refunded')),
  signature_verified_at timestamptz,
  webhook_event_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists payments_registration_active_idx on payments(registration_id) where status in ('created','authorized','captured');
create index if not exists payments_status_idx on payments(status, created_at desc);
create table if not exists razorpay_webhook_events (
  event_id text primary key,
  event_type text not null,
  order_id text,
  payload_sha256 text not null,
  processed_at timestamptz not null default now()
);
create table if not exists refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id) on delete restrict,
  amount_paise integer not null check(amount_paise > 0),
  reason text not null,
  status text not null default 'requested' check(status in ('requested','approved','rejected','processing','completed','failed')),
  provider_refund_id text unique,
  webhook_event_id text unique,
  decided_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists refunds_one_open_per_payment_idx on refunds(payment_id) where status not in ('rejected','failed');
create table if not exists payout_records (
  id uuid primary key default gen_random_uuid(),
  cash_reward_id uuid not null references cash_reward_records(id) on delete restrict,
  amount_paise integer not null check(amount_paise > 0),
  status text not null default 'pending' check(status in ('pending','processing','paid','failed')),
  provider_reference text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists payout_records_reward_idx on payout_records(cash_reward_id);

create table if not exists follows (
  follower_id uuid not null references users(id) on delete cascade,
  followed_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(follower_id, followed_id),
  check(follower_id <> followed_id)
);
create index if not exists follows_followed_idx on follows(followed_id);
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  href text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications(user_id, read_at, created_at desc);
create table if not exists support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  category text not null,
  subject text not null,
  status text not null default 'open' check(status in ('open','in_progress','resolved','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  sender_id uuid references users(id) on delete set null,
  sender_role text not null check(sender_role in ('player','admin')),
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists support_ticket_user_idx on support_tickets(user_id, updated_at desc);

create table if not exists site_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  active boolean not null default true,
  published_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists upcoming_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  href text,
  visible boolean not null default false,
  pinned boolean not null default false,
  display_order integer not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists uploaded_assets (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  mime_type text not null,
  byte_size integer not null check(byte_size > 0),
  uploaded_by uuid references users(id) on delete set null,
  approved boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists approved_profile_assets (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references uploaded_assets(id) on delete restrict,
  asset_type text not null check(asset_type in ('avatar','background','banner')),
  label text not null,
  public_url text,
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  unique(asset_id, asset_type)
);
alter table player_profiles add constraint player_avatar_asset_fk foreign key(avatar_asset_id) references approved_profile_assets(id) on delete set null;
alter table player_profiles add constraint player_background_asset_fk foreign key(background_asset_id) references approved_profile_assets(id) on delete set null;
alter table player_profiles add constraint player_banner_asset_fk foreign key(banner_asset_id) references approved_profile_assets(id) on delete set null;
create table if not exists admin_actions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references users(id) on delete restrict,
  action text not null,
  subject_type text not null,
  subject_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references users(id) on delete set null,
  event text not null,
  subject_type text,
  subject_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on audit_logs(created_at desc);
create table if not exists site_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);

-- Admin inbox persists platform events; it is intentionally separate from player notifications.
create table if not exists admin_notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  title text not null,
  body text not null default '',
  href text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists admin_notifications_idx on admin_notifications(read_at, created_at desc);

-- Basic supported game catalog; tournaments and entries remain empty until configured by an admin.
insert into games(name, slug, description) values
  ('Valorant', 'valorant', 'Tactical 5v5 competition.'),
  ('BGMI', 'bgmi', 'Battle royale competition.'),
  ('Call of Duty: Mobile', 'cod-mobile', 'Mobile multiplayer competition.')
on conflict (slug) do nothing;
insert into game_formats(game_id, name, participant_count)
select g.id, f.name, f.n from games g cross join (values ('Solo',1),('Duo',2),('Squad',4),('5v5',5)) as f(name,n)
where (g.slug in ('bgmi','cod-mobile') and f.name in ('Solo','Duo','Squad')) or (g.slug = 'valorant' and f.name in ('5v5'))
on conflict (game_id, name) do nothing;
