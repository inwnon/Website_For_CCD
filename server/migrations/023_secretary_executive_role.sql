-- Adds เลขานุการผู้บริหาร (secretary) and ผู้บริหาร (executive) for the back-office modules (SPEC.md §2).
-- On its own because a new enum value cannot be used in the transaction that adds it (024 uses them).
alter type user_role add value if not exists 'secretary';
alter type user_role add value if not exists 'executive';
