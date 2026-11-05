-- Milestone 2: optimistic concurrency, one live session per participant, query indexes.
alter table interview_sessions add column version int not null default 0;

-- A participant can only have one interview in progress or paused at a time.
create unique index one_live_session_per_participant
  on interview_sessions (participant_id) where status in ('in_progress', 'paused');

create index evidence_by_discovery on evidence_records (discovery_id, pain_point_key);
create index audit_by_discovery on audit_log (discovery_id, created_at);
create index usage_by_discovery on ai_usage (discovery_id);
create index escalations_open on escalations (status) where status = 'open';
