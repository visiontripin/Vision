-- Runtime primitives for private uploads, a transactional outbox and quota holds.
-- Every externally visible media object remains private; only moderation may publish.

ALTER TABLE media_objects
  ADD COLUMN content_type text NOT NULL DEFAULT 'application/octet-stream'
    CHECK (content_type = 'application/octet-stream' OR content_type ~ '^audio/[a-z0-9.+-]{1,64}$');
ALTER TABLE media_objects ALTER COLUMN content_type DROP DEFAULT;

ALTER TABLE user_quotas
  ADD COLUMN quota_month date NOT NULL DEFAULT date_trunc('month', now())::date,
  ADD COLUMN storage_reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_reserved_bytes >= 0);

CREATE TABLE upload_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  bucket_name text NOT NULL,
  object_key text NOT NULL UNIQUE,
  expected_content_type text NOT NULL CHECK (expected_content_type ~ '^audio/[a-z0-9.+-]{1,64}$'),
  expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled', 'expired')),
  idempotency_key text,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  media_object_id uuid REFERENCES media_objects(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX upload_intents_owner_created_idx ON upload_intents(owner_id, created_at DESC);
CREATE INDEX upload_intents_expiry_idx ON upload_intents(expires_at) WHERE status = 'pending';
CREATE UNIQUE INDEX upload_intents_owner_idempotency_idx
  ON upload_intents(owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE platform_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL CHECK (length(topic) BETWEEN 1 AND 120),
  aggregate_id uuid,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  dead_lettered_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (processed_at IS NOT NULL AND dead_lettered_at IS NOT NULL))
);
CREATE INDEX platform_outbox_pending_idx ON platform_outbox(available_at, created_at)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX media_objects_quarantine_idx ON media_objects(created_at, track_id)
  WHERE lifecycle_state = 'quarantine';
CREATE INDEX play_events_received_idx ON play_events(received_at DESC);
