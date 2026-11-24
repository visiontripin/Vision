CREATE TABLE radio_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'expired')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  mood text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(prefs) = 'object'),
  CHECK ((status = 'active' AND ended_at IS NULL) OR (status <> 'active'))
);
CREATE INDEX radio_sessions_user_status_idx ON radio_sessions(user_id, status, started_at DESC);

CREATE TABLE radio_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES radio_sessions(id) ON DELETE CASCADE,
  position bigint NOT NULL CHECK (position >= 0),
  segment_type text NOT NULL CHECK (segment_type IN ('music', 'host', 'quiz', 'lifehack', 'weather', 'news', 'jingle', 'ad', 'promo')),
  ref_id uuid,
  media_object_id uuid REFERENCES media_objects(id) ON DELETE RESTRICT,
  duration_ms integer NOT NULL CHECK (duration_ms > 0),
  mix jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(mix) = 'object'),
  script_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, position),
  CHECK (expires_at > created_at)
);
CREATE INDEX radio_schedule_session_idx ON radio_schedule(session_id, position);
CREATE INDEX radio_schedule_expiry_idx ON radio_schedule(expires_at);

CREATE TABLE radio_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('host', 'quiz', 'lifehack', 'weather', 'news', 'jingle')),
  template text NOT NULL CHECK (length(template) BETWEEN 1 AND 10_000),
  variables jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(variables) = 'object'),
  tone text NOT NULL DEFAULT 'neutral',
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE radio_schedule ADD CONSTRAINT radio_schedule_script_fk
  FOREIGN KEY (script_id) REFERENCES radio_scripts(id) ON DELETE SET NULL;

CREATE TABLE tts_cache (
  hash char(64) PRIMARY KEY CHECK (hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL,
  voice text NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 10_000),
  media_object_id uuid REFERENCES media_objects(id) ON DELETE RESTRICT,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  cost_microunits bigint CHECK (cost_microunits IS NULL OR cost_microunits >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE radio_feedback (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES radio_sessions(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES radio_schedule(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction text NOT NULL CHECK (reaction IN ('like', 'dislike', 'skip', 'report')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, schedule_id)
);
