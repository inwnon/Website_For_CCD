-- Secretaries and executives are listed in pr_team like the other given roles (admin.html), with no unit
alter table pr_team drop constraint pr_team_role_check;
alter table pr_team add constraint pr_team_role_check check (role in ('pr', 'admin', 'coordinator', 'intern', 'secretary', 'executive'));
