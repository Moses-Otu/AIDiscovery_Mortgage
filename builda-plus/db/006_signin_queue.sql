-- Push-button sign-in (demo mode) and the JADA work queue.

alter table jada_staff_roles drop constraint jada_staff_roles_role_check;
alter table jada_staff_roles add constraint jada_staff_roles_role_check
  check (role in ('knowledge_editor', 'compliance_reviewer', 'engineer'));

-- Display names for people who sign in (firm leads and JADA staff). Participants are not here:
-- they use their interview link.
create table app_users (
  id uuid primary key,
  display_name text not null check (length(display_name) between 1 and 120),
  kind text not null check (kind in ('firm_lead', 'jada')),
  created_at timestamptz not null default now()
);
grant insert on app_users to builda_app;   -- read only through the functions below

-- The sign-in page's list of accounts. The app only calls this in demo mode.
create function signin_directory()
returns table (user_id uuid, display_name text, kind text, org_id uuid, org_name text, roles text[])
language sql stable security definer set search_path = public as $$
  select u.id, u.display_name, u.kind, m.org_id, o.name,
         coalesce(array_agg(distinct r.role) filter (where r.role is not null), '{}')
    from app_users u
    left join org_members m on m.user_id = u.id
    left join organisations o on o.id = m.org_id
    left join jada_staff_roles r on r.user_id = u.id
   group by u.id, u.display_name, u.kind, m.org_id, o.name
   order by u.kind desc, o.name nulls last, u.display_name
$$;

-- Discoveries waiting for an engineer: firm name and reason only, until someone picks one up.
create function jada_queue(p_user uuid)
returns table (discovery_id uuid, firm_name text, reason text, since timestamptz)
language sql stable security definer set search_path = public as $$
  select d.id, o.name,
         case when exists (select 1 from escalations e where e.discovery_id = d.id and e.status = 'open')
              then 'Someone asked for help' else 'Priorities approved — implementation pack ready' end,
         d.created_at
    from discoveries d join organisations o on o.id = d.org_id
   where exists (select 1 from jada_staff_roles r where r.user_id = p_user and r.role = 'engineer')
     and not exists (select 1 from jada_assignments a where a.discovery_id = d.id)
     and (d.status = 'priorities_approved'
          or exists (select 1 from escalations e where e.discovery_id = d.id and e.status = 'open'))
   order by d.created_at
$$;

create function jada_pick_up(p_user uuid, p_discovery uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if not exists (select 1 from jada_staff_roles where user_id = p_user and role = 'engineer') then return false; end if;
  select org_id into v_org from discoveries where id = p_discovery;
  if v_org is null then return false; end if;
  insert into jada_assignments (discovery_id, staff_user_id) values (p_discovery, p_user) on conflict do nothing;
  insert into audit_log (org_id, discovery_id, actor, action, entity_type, entity_id)
    values (v_org, p_discovery, 'jada:' || p_user, 'jada.picked_up', 'discovery', p_discovery::text);
  return true;
end $$;

revoke all on function signin_directory(), jada_queue(uuid), jada_pick_up(uuid, uuid) from public;
grant execute on function signin_directory(), jada_queue(uuid), jada_pick_up(uuid, uuid) to builda_app;
