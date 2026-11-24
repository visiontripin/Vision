ALTER TABLE tracks ADD COLUMN rights_offer_version text;

ALTER TABLE moderation_queue DROP CONSTRAINT moderation_queue_status_check;
ALTER TABLE moderation_queue ADD CONSTRAINT moderation_queue_status_check
  CHECK (status IN ('pending', 'assigned', 'approved', 'rejected', 'escalated', 'superseded'));

CREATE TABLE platform_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type text NOT NULL CHECK (target_type IN ('track', 'moderation', 'rights_claim', 'user')),
  target_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_target_idx ON platform_audit_events(target_type, target_id, created_at DESC);
CREATE INDEX platform_audit_actor_idx ON platform_audit_events(actor_id, created_at DESC);

ALTER TABLE rights_claims ADD COLUMN claim_text text NOT NULL DEFAULT '' CHECK (length(claim_text) <= 5000);
ALTER TABLE rights_claims ADD COLUMN counter_notice_text text;
ALTER TABLE rights_claims ADD COLUMN counter_notice_at timestamptz;
ALTER TABLE rights_claims ADD COLUMN counter_notice_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Older rows could use the counter_notice status without retaining the notice itself.
-- Reopen those claims instead of inventing evidence or treating them as reviewed.
INSERT INTO platform_audit_events (action, target_type, target_id, reason, details)
SELECT 'rights_claim.counter_notice_reopened_by_migration', 'rights_claim', id,
  'counter_notice_details_missing', jsonb_build_object('trackId', track_id)
FROM rights_claims
WHERE status = 'counter_notice';
UPDATE rights_claims SET status = 'open', resolved_at = NULL WHERE status = 'counter_notice';
ALTER TABLE rights_claims ADD CONSTRAINT rights_claims_counter_notice_fields_check CHECK (
  status <> 'counter_notice'
  OR (counter_notice_text IS NOT NULL AND length(trim(counter_notice_text)) BETWEEN 20 AND 5000
      AND counter_notice_at IS NOT NULL AND counter_notice_by IS NOT NULL)
);

-- Legacy publications without a versioned acknowledgement require owner resubmission;
-- active rights claims take precedence and keep affected tracks down.
INSERT INTO platform_audit_events (action, target_type, target_id, reason, details)
SELECT 'track.migrated_to_quarantine', 'track', t.id, 'rights_offer_version_missing',
  jsonb_build_object('previousStatus', t.status, 'previousVisibility', t.visibility, 'previousPublishedAt', t.published_at)
FROM tracks t
WHERE t.status IN ('published', 'in_review')
  AND t.rights_offer_version IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM rights_claims c
    WHERE c.track_id = t.id AND c.status IN ('open', 'counter_notice', 'accepted')
  );
INSERT INTO platform_audit_events (action, target_type, target_id, reason, details)
SELECT 'track.migrated_to_takedown', 'track', t.id, 'open_rights_claim',
  jsonb_build_object('previousStatus', t.status, 'previousVisibility', t.visibility, 'previousPublishedAt', t.published_at)
FROM tracks t
WHERE t.status IN ('published', 'in_review')
  AND EXISTS (
    SELECT 1 FROM rights_claims c
    WHERE c.track_id = t.id AND c.status IN ('open', 'counter_notice', 'accepted')
  );

-- Record every queue item that will be superseded, including duplicate active tasks.
INSERT INTO platform_audit_events (action, target_type, target_id, reason, details)
SELECT 'moderation.superseded_by_migration', 'moderation', m.id,
  CASE
    WHEN claimed_track.id IS NOT NULL THEN 'open_rights_claim'
    WHEN unversioned_track.id IS NOT NULL THEN 'rights_offer_version_missing'
    ELSE 'duplicate_open_moderation_item'
  END,
  jsonb_build_object('trackId', m.track_id, 'previousStatus', m.status, 'previousDecision', m.decision)
FROM moderation_queue m
LEFT JOIN tracks unversioned_track
  ON unversioned_track.id = m.track_id
  AND unversioned_track.status IN ('published', 'in_review')
  AND unversioned_track.rights_offer_version IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM rights_claims c
    WHERE c.track_id = unversioned_track.id AND c.status IN ('open', 'counter_notice', 'accepted')
  )
LEFT JOIN tracks claimed_track
  ON claimed_track.id = m.track_id
  AND EXISTS (
    SELECT 1 FROM rights_claims c
    WHERE c.track_id = claimed_track.id AND c.status IN ('open', 'counter_notice', 'accepted')
  )
LEFT JOIN (
  SELECT id,
    ROW_NUMBER() OVER (PARTITION BY track_id ORDER BY created_at DESC, id DESC) AS item_rank
  FROM moderation_queue
  WHERE status IN ('pending', 'assigned', 'escalated')
) duplicate_item ON duplicate_item.id = m.id
WHERE unversioned_track.id IS NOT NULL
   OR claimed_track.id IS NOT NULL
   OR (m.status IN ('pending', 'assigned', 'escalated') AND duplicate_item.item_rank > 1);

-- Keep only the newest active item for unaffected tracks; older rows remain auditable.
WITH ranked_active AS (
  SELECT id,
    ROW_NUMBER() OVER (PARTITION BY track_id ORDER BY created_at DESC, id DESC) AS item_rank
  FROM moderation_queue
  WHERE status IN ('pending', 'assigned', 'escalated')
)
UPDATE moderation_queue m
SET status = 'superseded', assignee_id = NULL, decision = NULL, decided_at = NULL
FROM ranked_active r
WHERE r.id = m.id
  AND r.item_rank > 1
  AND NOT EXISTS (
    SELECT 1
    FROM tracks t
    WHERE t.id = m.track_id
      AND (
        (t.status IN ('published', 'in_review') AND t.rights_offer_version IS NULL)
        OR EXISTS (
          SELECT 1 FROM rights_claims c
          WHERE c.track_id = t.id AND c.status IN ('open', 'counter_notice', 'accepted')
        )
      )
  );

-- No historical approval or open queue may survive a missing acknowledgement or active claim.
UPDATE moderation_queue
SET status = 'superseded', assignee_id = NULL, decision = NULL, decided_at = NULL
WHERE track_id IN (
  SELECT t.id
  FROM tracks t
  WHERE (t.status IN ('published', 'in_review') AND t.rights_offer_version IS NULL)
     OR EXISTS (
       SELECT 1 FROM rights_claims c
       WHERE c.track_id = t.id AND c.status IN ('open', 'counter_notice', 'accepted')
     )
);
UPDATE tracks t
SET status = 'taken_down', visibility = 'private', published_at = NULL
WHERE t.status IN ('published', 'in_review')
  AND EXISTS (
    SELECT 1 FROM rights_claims c
    WHERE c.track_id = t.id AND c.status IN ('open', 'counter_notice', 'accepted')
  );
UPDATE tracks t
SET status = 'quarantine', visibility = 'private', rights_confirmed_at = NULL, published_at = NULL
WHERE t.status IN ('published', 'in_review')
  AND t.rights_offer_version IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM rights_claims c
    WHERE c.track_id = t.id AND c.status IN ('open', 'counter_notice', 'accepted')
  );

ALTER TABLE tracks ADD CONSTRAINT tracks_rights_offer_version_check
  CHECK (rights_offer_version IS NULL OR length(trim(rights_offer_version)) BETWEEN 1 AND 100);
ALTER TABLE tracks ADD CONSTRAINT tracks_published_rights_offer_check
  CHECK (status <> 'published' OR rights_offer_version IS NOT NULL);
CREATE UNIQUE INDEX moderation_queue_one_open_per_track_idx ON moderation_queue(track_id)
  WHERE status IN ('pending', 'assigned', 'escalated');

-- A concurrent/direct SQL publisher must not bypass an unresolved rights complaint.
CREATE OR REPLACE FUNCTION require_approved_moderation_before_publish()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'published' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'published') THEN
    IF NOT EXISTS (
      SELECT 1 FROM (
        SELECT status, decided_at
        FROM moderation_queue
        WHERE track_id = NEW.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) latest_decision
      WHERE status = 'approved' AND decided_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'track % cannot be published without an approved moderation decision', NEW.id
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM rights_claims
      WHERE track_id = NEW.id AND status IN ('open', 'counter_notice', 'accepted')
    ) THEN
      RAISE EXCEPTION 'track % cannot be published with an unresolved rights claim', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE INDEX rights_claims_counter_by_idx ON rights_claims(counter_notice_by, counter_notice_at DESC)
  WHERE status = 'counter_notice';
