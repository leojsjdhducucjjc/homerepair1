create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  email text,
  password_hash text not null,
  password_salt text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users add column if not exists email text;

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.quote_requests (
  id text primary key,
  submitted_at timestamptz not null default now(),
  name text not null,
  phone text not null,
  email text not null,
  city text not null,
  service text not null,
  timeline text not null default '',
  details text not null default ''
);

create table if not exists public.invoices (
  id text primary key,
  quote_request_id text not null references public.quote_requests(id) on delete cascade,
  customer_name text not null default '',
  customer_email text not null default '',
  title text not null default 'Project Invoice',
  notes text not null default '',
  line_items jsonb not null default '[]'::jsonb,
  subtotal numeric(10, 2) not null default 0,
  total numeric(10, 2) not null default 0,
  due_date date,
  status text not null default 'sent',
  square_payment_link_id text not null default '',
  square_payment_link_url text not null default '',
  square_order_id text not null default '',
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.invoices add column if not exists square_payment_link_id text not null default '';
alter table public.invoices add column if not exists square_payment_link_url text not null default '';
alter table public.invoices add column if not exists square_order_id text not null default '';

create index if not exists sessions_user_id_idx on public.sessions(user_id);
create index if not exists sessions_expires_at_idx on public.sessions(expires_at);
create index if not exists quote_requests_submitted_at_idx on public.quote_requests(submitted_at desc);
create unique index if not exists users_email_unique_idx on public.users (lower(email)) where email is not null and email <> '';
create index if not exists invoices_quote_request_id_idx on public.invoices(quote_request_id);
create index if not exists invoices_created_at_idx on public.invoices(created_at desc);
