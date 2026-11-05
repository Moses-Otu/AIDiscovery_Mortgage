-- builda+ core schema (brief §8.4). Every firm-owned row carries org_id and is protected by RLS.
-- The application connects as role `builda_app` (NOT the table owner) and sets, per transaction:
--   SET LOCAL app.current_org_id = '<uuid>';   SET LOCAL app.current_user_id = '<uuid>';

create extension if not exists pgcrypto;

create type member_role as enum ('firm_lead', 'participant');
create type participant_role as enum ('firm_lead', 'adviser', 'case_manager', 'administrator', 'other');
create type session_status as enum ('invited', 'in_progress', 'paused', 'completed', 'escalated');
create type evidence_source as enum ('firm_said', 'operational_record', 'measured_baseline', 'playbook', 'assumption');
create type classification as enum ('overhaul', 'fix', 'automate', 'keep_human');
create type confidence_level as enum ('insufficient', 'low', 'medium', 'high', 'very_high');

create table organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table org_members (
  org_id uuid not null references organisations(id),
  user_id uuid not null,
  role member_role not null,
  primary key (org_id, user_id)
);

create table discoveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  status text not null default 'draft',
  firm_profile jsonb not null default '{}'::jsonb,
  playbook_version text not null,
  scoring_config_version text not null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

-- JADA staff see only discoveries they are assigned to (brief §10).
create table jada_assignments (
  discovery_id uuid not null references discoveries(id),
  staff_user_id uuid not null,
  primary key (discovery_id, staff_user_id)
);

create table participants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  user_id uuid,
  display_name text not null,             -- never sent to the AI
  pseudonym text not null,                -- e.g. 'P3'; the only identifier the AI sees
  role participant_role not null,
  consent_version text,
  consented_at timestamptz,
  share_name_with_management boolean not null default false,
  unique (discovery_id, pseudonym)
);

create table interview_sessions (
  id uuid primary key,
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  participant_id uuid not null references participants(id),
  status session_status not null default 'invited',
  state jsonb not null,                    -- serialised InterviewState (transcript stored redacted)
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table evidence_records (
  id uuid primary key,
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  session_id uuid references interview_sessions(id),
  participant_pseudonym text,
  source evidence_source not null,
  pain_point_key text not null,
  stage_id text not null,
  task_description text not null,
  responsible_role participant_role not null,
  monthly_volume numeric,
  minutes_per_occurrence numeric,
  people_involved int,
  systems text[] not null default '{}',
  operational_impact text,
  reported_cause text,
  potential_improvement text,
  supporting_quote text not null,
  outstanding_questions text[] not null default '{}',
  conversion_assumptions text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table pain_points (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  key text not null,
  stage_id text not null,
  title text not null,
  classification classification,
  classification_rationale text,
  confidence confidence_level not null default 'insufficient',
  confidence_detail jsonb not null default '{}'::jsonb,   -- disagreements preserved for firm-lead review
  validated_by_firm_lead boolean not null default false,
  unique (discovery_id, key)
);

create table opportunities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  pain_point_id uuid not null references pain_points(id),
  impact jsonb not null,
  score numeric,
  score_breakdown jsonb,
  scoring_config_version text not null,
  rank int,
  feasibility jsonb
);

create table corrections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  entity_type text not null,
  entity_id uuid not null,
  field text not null,
  old_value jsonb,
  new_value jsonb,
  reason text,
  corrected_by uuid not null,
  created_at timestamptz not null default now()
);

create table escalations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  session_id uuid references interview_sessions(id),
  reason text not null,
  details_redacted text,
  status text not null default 'open',
  assigned_to uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table ai_usage (
  id bigserial primary key,
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  task text not null,
  model text not null,
  input_tokens int not null,
  output_tokens int not null,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  org_id uuid not null references organisations(id),
  discovery_id uuid references discoveries(id),
  actor text not null,                 -- user id, 'system' or 'ai:<task>'
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Session context helpers
create function app_org() returns uuid language sql stable as
  $$ select nullif(current_setting('app.current_org_id', true), '')::uuid $$;
create function app_user() returns uuid language sql stable as
  $$ select nullif(current_setting('app.current_user_id', true), '')::uuid $$;
create function app_jada_assigned(d uuid) returns boolean language sql stable security definer set search_path = public as
  $$ select exists (select 1 from jada_assignments where discovery_id = d and staff_user_id = app_user()) $$;

-- Row-level security
alter table organisations enable row level security;  alter table organisations force row level security;
alter table org_members  enable row level security;   alter table org_members  force row level security;
create policy org_self on organisations using (id = app_org());
create policy members_self on org_members using (org_id = app_org());

do $$
declare t text;
begin
  foreach t in array array['discoveries','participants','interview_sessions','evidence_records','pain_points',
                           'opportunities','corrections','escalations','ai_usage','audit_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy firm_isolation on %I
       using (org_id = app_org() or app_jada_assigned(%s))
       with check (org_id = app_org() or app_jada_assigned(%s))$p$,
       t, case when t = 'discoveries' then 'id' else 'discovery_id' end,
          case when t = 'discoveries' then 'id' else 'discovery_id' end);
  end loop;
end $$;

alter table jada_assignments enable row level security; alter table jada_assignments force row level security;
create policy own_assignments on jada_assignments using (staff_user_id = app_user());

-- Application role: ordinary DML, but the audit log is append-only.
do $$ begin
  if not exists (select from pg_roles where rolname = 'builda_app') then create role builda_app login; end if;
end $$;
grant usage on schema public to builda_app;
grant select, insert, update, delete on all tables in schema public to builda_app;
grant usage on all sequences in schema public to builda_app;
revoke update, delete on audit_log, corrections from builda_app;
