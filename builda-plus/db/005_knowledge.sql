-- Milestone 8: versioned knowledge (cards, regulatory checks, sources) with four-eyes approval and releases.
-- Knowledge is JADA-owned and shared across firms; it never contains firm data.

create table jada_staff_roles (
  user_id uuid not null,
  role text not null check (role in ('knowledge_editor', 'compliance_reviewer')),
  primary key (user_id, role)
);

create table knowledge_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('card', 'check', 'source')),
  key text not null check (key ~ '^[a-z0-9][a-z0-9_.-]{1,80}$'),
  version int not null,
  content jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'rejected')),
  author_id uuid not null,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  unique (kind, key, version),
  check (reviewed_by is null or reviewed_by <> author_id)       -- four eyes, enforced by the database too
);

-- Releases are immutable snapshots of approved items. Discoveries pin one by version.
create table knowledge_releases (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  item_ids uuid[] not null,
  snapshot jsonb not null,
  notes text,
  published_by uuid not null,
  created_at timestamptz not null default now()
);

grant select, insert, update on knowledge_items to builda_app;
grant select, insert on knowledge_releases, jada_staff_roles to builda_app;
revoke update, delete on knowledge_releases from builda_app;
revoke delete on knowledge_items from builda_app;
revoke insert, update, delete on jada_staff_roles from builda_app;   -- roles are granted by an administrator

-- Pain points seen in discoveries but missing from a release: aggregated across firms with no firm
-- identifiers or quotes, and only when at least two firms raised them. Callable only by knowledge staff.
create function knowledge_candidates(p_caller uuid, p_known_keys text[])
returns table (key text, title text, stage_id text, firms bigint)
language sql stable security definer set search_path = public as $$
  select pp.key, min(pp.title), mode() within group (order by pp.stage_id), count(distinct pp.org_id)
    from pain_points pp
   where exists (select 1 from jada_staff_roles r where r.user_id = p_caller)
     and not (pp.key = any(p_known_keys))
   group by pp.key
  having count(distinct pp.org_id) >= 2
   order by count(distinct pp.org_id) desc, pp.key
$$;
revoke all on function knowledge_candidates(uuid, text[]) from public;
grant execute on function knowledge_candidates(uuid, text[]) to builda_app;
