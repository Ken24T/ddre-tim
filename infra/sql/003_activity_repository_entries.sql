create table if not exists activity_repository_entries (
  id text primary key,
  slug text not null unique,
  name text not null,
  color text,
  department_id text,
  kind text not null default 'timed',
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint activity_repository_entries_kind_valid check (kind in ('timed', 'non-timed')),
  constraint activity_repository_entries_name_nonempty check (name <> '')
);

create index if not exists idx_activity_repository_entries_active_name
  on activity_repository_entries (is_active, name);