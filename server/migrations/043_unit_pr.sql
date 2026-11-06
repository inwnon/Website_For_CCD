-- "ฉันเป็นประชาสัมพันธ์ของคณะ/หน่วยงาน" (login.html step 2, staff only): ticked → listed on contact.html.
-- Replaces reading the free-text position. Staff listed under the old rule are ticked here, so nobody drops off the page.
alter table users add column unit_pr boolean not null default false;
update users set unit_pr = true
 where role in ('staff', 'coordinator', 'secretary', 'executive')
   and position ~* '(ประชาสัมพันธ์|สื่อสารองค์กร|\mPR\M)';
