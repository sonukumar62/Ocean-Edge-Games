-- Payment method configuration and private manual-payment review records.
alter table tournament_registrations add column if not exists payment_method text not null default 'razorpay';
alter table tournament_registrations add column if not exists payment_qr_path text;
alter table tournament_registrations add column if not exists payment_upi_id text;
alter table tournament_registrations drop constraint if exists tournament_registrations_payment_method_check;
alter table tournament_registrations add constraint tournament_registrations_payment_method_check check (payment_method in ('razorpay','manual'));

alter table tournament_registrations drop constraint if exists tournament_registrations_payment_status_check;
alter table tournament_registrations add constraint tournament_registrations_payment_status_check check (payment_status in ('unpaid','pending','paid','failed','refunded','not_required','pending_verification','rejected'));

alter table payments add column if not exists payment_method text not null default 'razorpay';
alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check check (status in ('created','authorized','captured','failed','refunded','pending_verification','verified'));
alter table payments drop constraint if exists payments_payment_method_check;
alter table payments add constraint payments_payment_method_check check (payment_method in ('razorpay','manual'));
drop index if exists payments_registration_active_idx;
create unique index payments_registration_active_idx on payments(registration_id)
  where status in ('created','authorized','captured','pending_verification','verified');

create table if not exists manual_payment_proofs (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id) on delete restrict,
  storage_path text,
  mime_type text not null check (mime_type in ('image/png','image/jpeg','image/webp')),
  byte_size integer not null check (byte_size between 1 and 4194304),
  submitted_by uuid not null references users(id) on delete restrict,
  review_status text not null default 'pending' check (review_status in ('pending','verified','rejected','deleted')),
  review_reason text,
  reviewed_by uuid references users(id) on delete set null,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  deleted_at timestamptz,
  unique(payment_id),
  check ((review_status='deleted' and storage_path is null) or (review_status<>'deleted' and storage_path is not null))
);
create index if not exists manual_payment_proofs_review_idx on manual_payment_proofs(review_status,submitted_at desc);

insert into site_settings(key,value) values('payment_configuration','{"method":"razorpay","upiId":"","qrPath":null}'::jsonb)
  on conflict(key) do nothing;
