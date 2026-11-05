-- Milestones 3–7: invitations, follow-ups, analysis runs, pain-point overrides.
alter table participants add column email text;           -- for invitations only; never sent to the AI
alter table participants add column invited_at timestamptz;

create table invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  participant_id uuid not null references participants(id),
  token_hash text not null unique,                        -- sha256 of the link token; the token itself is never stored
  expires_at timestamptz not null,
  first_used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table invitations enable row level security; alter table invitations force row level security;
-- An invitation can be looked up by its token hash before the firm is known. Nothing else is visible.
create policy invitation_access on invitations
  using (org_id = app_org() or token_hash = nullif(current_setting('app.invitation_hash', true), ''))
  with check (org_id = app_org());

alter table interview_sessions add column kind text not null default 'main';   -- 'main' | 'follow_up'
drop index one_live_session_per_participant;
create unique index one_live_session_per_participant
  on interview_sessions (participant_id) where status in ('in_progress', 'paused');

create table follow_ups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  participant_id uuid not null references participants(id),
  pain_point_key text not null,
  stage_id text not null,
  question text not null,
  reason text not null,
  status text not null default 'pending',                 -- pending | asked
  created_at timestamptz not null default now()
);

create table analysis_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  findings jsonb not null,
  key_merges jsonb not null default '[]'::jsonb,
  playbook_version text not null,
  created_at timestamptz not null default now()
);

alter table pain_points add column evidence_summary jsonb not null default '{}'::jsonb;
alter table pain_points add column overrides jsonb not null default '{}'::jsonb;   -- firm-lead corrected figures
alter table pain_points add column classification_source text;                     -- ai_proposed | playbook | firm_lead
alter table pain_points add column requires_compliance_review boolean not null default false;
alter table pain_points add column updated_at timestamptz not null default now();
alter table opportunities add column assumptions jsonb not null default '[]'::jsonb;
alter table opportunities add column explanation jsonb not null default '[]'::jsonb;

do $$
declare t text;
begin
  foreach t in array array['follow_ups','analysis_runs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy firm_isolation on %I using (org_id = app_org() or app_jada_assigned(discovery_id))
                     with check (org_id = app_org() or app_jada_assigned(discovery_id))$p$, t);
  end loop;
end $$;

grant select, insert, update, delete on invitations, follow_ups, analysis_runs to builda_app;
revoke update, delete on analysis_runs from builda_app;    -- each run is kept as a record
