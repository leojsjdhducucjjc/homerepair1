create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  password_salt text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create index if not exists sessions_user_id_idx on public.sessions(user_id);
create index if not exists sessions_expires_at_idx on public.sessions(expires_at);
create index if not exists quote_requests_submitted_at_idx on public.quote_requests(submitted_at desc);
