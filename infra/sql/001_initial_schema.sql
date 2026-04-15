create table if not exists departments (
  id uuid primary key,
  slug text not null unique,
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists users (
  id uuid primary key,
  display_name text not null,
  normalized_display_name text not null unique,
  default_department_id uuid references departments(id),
  is_active boolean not null default true,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint users_display_name_nonempty check (display_name <> ''),
  constraint users_normalized_display_name_nonempty check (normalized_display_name <> '')
);

create table if not exists activities (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  kind text not null,
  is_system boolean not null default false,
  is_active boolean not null default true,
  department_id uuid references departments(id),
  created_by_user_id uuid references users(id),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint activities_kind_valid check (kind in ('timed', 'non-timed')),
  constraint activities_name_nonempty check (name <> '')
);

create table if not exists user_activity_assignments (
  user_id uuid not null references users(id),
  activity_id uuid not null references activities(id),
  sort_order integer not null default 0,
  is_hidden boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (user_id, activity_id)
);

create table if not exists devices (
  id uuid primary key,
  user_id uuid not null references users(id),
  device_key text not null unique,
  platform text not null,
  last_seen_at timestamptz,
  created_at timestamptz not null
);

create table if not exists activity_events (
  id uuid primary key,
  user_id uuid not null references users(id),
  device_id uuid not null references devices(id),
  department_id uuid references departments(id),
  activity_id uuid references activities(id),
  event_type text not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null,
  idempotency_key text not null unique,
  note text,
  metadata jsonb not null default '{}',
  constraint activity_events_type_valid check (event_type in ('activity-selected', 'activity-cleared', 'note-added'))
);

create table if not exists manager_scopes (
  id uuid primary key,
  manager_user_id uuid not null references users(id),
  scope_type text not null,
  department_id uuid references departments(id),
  created_at timestamptz not null,
  constraint manager_scopes_type_valid check (scope_type in ('department', 'all'))
);

create table if not exists historical_tim_daily_records (
  id uuid primary key,
  source_record_key text not null unique,
  work_date date not null,
  employee_name text not null,
  department_name text not null,
  activity_name text not null,
  hours numeric(6,2) not null,
  source_file text not null,
  source_row_number integer not null,
  imported_at timestamptz not null,
  mapped_user_id uuid references users(id),
  mapped_department_id uuid references departments(id),
  mapped_activity_id uuid references activities(id),
  created_at timestamptz not null,
  constraint historical_tim_daily_records_hours_nonnegative check (hours >= 0)
);

create index if not exists idx_users_default_department_id on users (default_department_id);
create index if not exists idx_activities_department_id on activities (department_id);
create index if not exists idx_user_activity_assignments_sort on user_activity_assignments (user_id, sort_order);
create index if not exists idx_devices_user_id on devices (user_id);
create index if not exists idx_activity_events_user_occurred_at on activity_events (user_id, occurred_at);
create index if not exists idx_activity_events_department_id on activity_events (department_id);
create index if not exists idx_historical_tim_daily_records_work_date on historical_tim_daily_records (work_date);
create index if not exists idx_historical_tim_daily_records_mapped_user on historical_tim_daily_records (mapped_user_id, work_date);
create index if not exists idx_historical_tim_daily_records_mapped_department on historical_tim_daily_records (mapped_department_id, work_date);
create index if not exists idx_historical_tim_daily_records_mapped_activity on historical_tim_daily_records (mapped_activity_id, work_date);