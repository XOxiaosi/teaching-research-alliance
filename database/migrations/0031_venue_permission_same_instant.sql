-- A grant can be replaced again at the same business timestamp. Its empty
-- half-open interval remains in history and never grants access.
ALTER TABLE venue_permission_grant
  DROP CONSTRAINT venue_permission_grant_check,
  ADD CONSTRAINT venue_permission_valid_interval
    CHECK (valid_to IS NULL OR valid_to >= valid_from);
