\set ON_ERROR_STOP 1
-- seed as superuser (bypasses RLS)
insert into organisations(id,name) values ('00000000-0000-0000-0000-00000000000a','Firm A'),('00000000-0000-0000-0000-00000000000b','Firm B');
insert into discoveries(id,org_id,playbook_version,scoring_config_version,created_by) values
 ('10000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a','0.1.0','v1','00000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-00000000000b','0.1.0','v1','00000000-0000-0000-0000-000000000002');
insert into audit_log(org_id,actor,action) values ('00000000-0000-0000-0000-00000000000a','system','seed');
insert into jada_assignments values ('10000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-0000000000e1');

set role builda_app;
\echo '--- Firm A context: should see only Firm A discovery'
begin; set local app.current_org_id='00000000-0000-0000-0000-00000000000a';
select name from organisations; select org_id from discoveries; commit;
\echo '--- No context: should see nothing'
select count(*) as visible_without_context from discoveries;
\echo '--- JADA engineer assigned to Firm B discovery only'
begin; set local app.current_user_id='00000000-0000-0000-0000-0000000000e1';
select id from discoveries; commit;
\echo '--- Firm A trying to insert a row for Firm B: must fail'
begin; set local app.current_org_id='00000000-0000-0000-0000-00000000000a';
savepoint s;
\set ON_ERROR_STOP 0
insert into discoveries(org_id,playbook_version,scoring_config_version,created_by) values ('00000000-0000-0000-0000-00000000000b','x','x','00000000-0000-0000-0000-000000000001');
rollback to s;
\echo '--- Audit log update: must fail (append-only)'
update audit_log set action='tampered';
rollback;
