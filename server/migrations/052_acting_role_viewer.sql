-- =========================================================================
-- Developer accounts can also view the site as บุคลากร / นักศึกษา / บุคคลภายนอก
-- =========================================================================
-- acting_role (see 012): 'admin' = ผู้พัฒนาระบบ (the default), 'pr' = ทีม PR, and now the three ordinary roles for testing.
alter table sessions drop constraint if exists sessions_acting_role_check;
alter table sessions add constraint sessions_acting_role_check check (acting_role in ('pr', 'admin', 'staff', 'student', 'external'));
