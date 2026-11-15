-- New public-platform database only. The existing single-owner SQLite data store
-- remains separate until an explicit, tested migration is approved.
-- PostgreSQL 16 provides gen_random_uuid() natively. Case-insensitive email
-- uniqueness is implemented by a lower() index without requiring citext.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  password_hash text,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  avatar_url text,
  primary_role text NOT NULL DEFAULT 'listener'
    CHECK (primary_role IN ('listener', 'artist', 'moderator', 'admin')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'blocked', 'deleted')),
  locale text NOT NULL DEFAULT 'ru',
  country char(2),
  city text,
  totp_secret_ciphertext bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  deleted_at timestamptz,
  CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
);

CREATE UNIQUE INDEX users_email_ci_idx ON users(lower(email)) WHERE email IS NOT NULL;

CREATE TABLE auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('password', 'oauth', 'passkey')),
  provider_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);
CREATE INDEX auth_identities_user_idx ON auth_identities(user_id);

CREATE TABLE refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  rotated_to uuid REFERENCES refresh_sessions(id),
  revoked_at timestamptz,
  device_hash bytea,
  CHECK (expires_at > created_at)
);
CREATE INDEX refresh_sessions_user_expiry_idx ON refresh_sessions(user_id, expires_at);

CREATE TABLE artist_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stage_name text NOT NULL CHECK (length(trim(stage_name)) BETWEEN 1 AND 120),
  bio text NOT NULL DEFAULT '' CHECK (length(bio) <= 5000),
  links jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(links) = 'array'),
  verified boolean NOT NULL DEFAULT false,
  rights_confirmed_at timestamptz,
  offer_version text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(stats) = 'object'),
  pronunciation_dict jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(pronunciation_dict) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX artist_profiles_stage_name_ci_idx ON artist_profiles(lower(stage_name));

CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id uuid NOT NULL REFERENCES artist_profiles(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, artist_id),
  CHECK (follower_id <> artist_id)
);

CREATE TABLE tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  artist_display text NOT NULL CHECK (length(trim(artist_display)) BETWEEN 1 AND 300),
  album text,
  genre text,
  mood text[] NOT NULL DEFAULT '{}',
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  sha256 char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'unlisted', 'public')),
  status text NOT NULL DEFAULT 'quarantine'
    CHECK (status IN ('quarantine', 'in_review', 'published', 'rejected', 'taken_down')),
  fingerprint jsonb,
  plays bigint NOT NULL DEFAULT 0 CHECK (plays >= 0),
  likes bigint NOT NULL DEFAULT 0 CHECK (likes >= 0),
  rights_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK (visibility <> 'public' OR status = 'published'),
  CHECK (status <> 'published' OR rights_confirmed_at IS NOT NULL)
);
CREATE INDEX tracks_owner_status_idx ON tracks(owner_id, status);
CREATE INDEX tracks_publication_idx ON tracks(visibility, published_at DESC) WHERE status = 'published';
CREATE INDEX tracks_catalog_text_idx ON tracks USING gin (
  to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(artist_display, ''))
);

CREATE TABLE media_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  object_kind text NOT NULL CHECK (object_kind IN ('original', 'cover', 'opus', 'aac', 'hls_segment')),
  bucket_name text NOT NULL,
  object_key text NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  lifecycle_state text NOT NULL DEFAULT 'quarantine'
    CHECK (lifecycle_state IN ('quarantine', 'ready', 'pending_delete', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (bucket_name, object_key)
);
CREATE INDEX media_objects_track_idx ON media_objects(track_id, object_kind);

CREATE TABLE track_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  media_object_id uuid NOT NULL REFERENCES media_objects(id) ON DELETE RESTRICT,
  codec text NOT NULL CHECK (codec IN ('original', 'opus', 'aac', 'hls')),
  bitrate_kbps integer CHECK (bitrate_kbps IS NULL OR bitrate_kbps > 0),
  is_hls boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (track_id, codec, media_object_id)
);

CREATE TABLE user_quotas (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  storage_limit_bytes bigint NOT NULL CHECK (storage_limit_bytes >= 0),
  monthly_upload_limit integer NOT NULL CHECK (monthly_upload_limit >= 0),
  storage_used_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_used_bytes >= 0),
  uploads_this_month integer NOT NULL DEFAULT 0 CHECK (uploads_this_month >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE moderation_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  reason text NOT NULL,
  auto_score numeric(6, 5) CHECK (auto_score IS NULL OR auto_score BETWEEN 0 AND 1),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'assigned', 'approved', 'rejected', 'escalated')),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  decision text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status IN ('approved', 'rejected') AND decided_at IS NOT NULL AND decision IS NOT NULL)
    OR (status NOT IN ('approved', 'rejected') AND decided_at IS NULL)
  )
);
CREATE INDEX moderation_queue_pending_idx ON moderation_queue(created_at) WHERE status IN ('pending', 'assigned', 'escalated');
CREATE INDEX moderation_queue_approved_track_idx ON moderation_queue(track_id, decided_at DESC) WHERE status = 'approved';
CREATE INDEX moderation_queue_latest_idx ON moderation_queue(track_id, created_at DESC, id DESC);

-- Defense in depth: direct SQL cannot make a quarantined track public without an
-- approved moderation record. The API must still authorize who can create that record.
CREATE FUNCTION require_approved_moderation_before_publish()
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
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tracks_require_moderation_before_publish
  BEFORE INSERT OR UPDATE OF status ON tracks
  FOR EACH ROW EXECUTE FUNCTION require_approved_moderation_before_publish();

CREATE TABLE rights_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE RESTRICT,
  claimant_email text,
  claimant_name text,
  evidence_url text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'accepted', 'rejected', 'counter_notice')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  sla_due_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX rights_claims_open_sla_idx ON rights_claims(sla_due_at) WHERE status = 'open';

CREATE TABLE idempotency_keys (
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response_status smallint,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (actor_id, idempotency_key),
  CHECK (expires_at > created_at)
);
