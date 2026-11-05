-- Milestones 9–10: report snapshots, firm-lead approval, implementation packs, JADA reviews.

-- Each generated report is an immutable snapshot: the baseline for later before/after comparison.
create table reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  version int not null,
  model jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (discovery_id, version)
);

create table priority_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  priorities uuid[] not null,              -- pain point ids in the order the firm lead approved
  proceed_with uuid references pain_points(id),
  note text,
  approved_by uuid not null,
  created_at timestamptz not null default now()
);

create table implementation_packs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  pain_point_id uuid not null references pain_points(id),
  approval_id uuid not null references priority_approvals(id),
  content jsonb not null,
  status text not null default 'in_review',   -- in_review | needs_changes | confirmed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table pack_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organisations(id),
  discovery_id uuid not null references discoveries(id),
  pack_id uuid not null references implementation_packs(id),
  reviewer_id uuid not null,
  checks jsonb not null,
  result jsonb not null,                   -- assessTwoWeekFeasibility output
  decision text not null,                  -- confirmed | needs_changes
  notes text,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['reports','priority_approvals','implementation_packs','pack_reviews'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy firm_isolation on %I using (org_id = app_org() or app_jada_assigned(discovery_id))
                     with check (org_id = app_org() or app_jada_assigned(discovery_id))$p$, t);
  end loop;
end $$;

-- Assigned JADA staff may read the name of the firm they're working with.
create policy jada_assigned_org on organisations
  using (exists (select 1 from discoveries d where d.org_id = organisations.id and app_jada_assigned(d.id)));

grant select, insert, update, delete on reports, priority_approvals, implementation_packs, pack_reviews to builda_app;
revoke update, delete on reports, priority_approvals, pack_reviews from builda_app;
