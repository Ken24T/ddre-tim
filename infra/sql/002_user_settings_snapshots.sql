create table if not exists user_settings_snapshots (
  user_id text primary key,
  settings_payload jsonb not null,
  updated_at timestamptz not null
);

create index if not exists idx_user_settings_snapshots_updated_at
  on user_settings_snapshots (updated_at);