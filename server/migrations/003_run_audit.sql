-- Who recorded and who voided each run (requirement RUN-10, decision D-25).
-- The person's id and name are saved on the run itself: the business-scoped database role cannot read
-- the users table, and a saved name keeps showing correctly even if the person is renamed or switched off.
-- Runs saved before this change have no recorded person (empty name).
-- No change to row-level security: the existing policy and grants on runs cover these columns.

ALTER TABLE runs ADD COLUMN created_by_user_id integer;
ALTER TABLE runs ADD COLUMN created_by_name text NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN voided_by_user_id integer;
ALTER TABLE runs ADD COLUMN voided_by_name text;
