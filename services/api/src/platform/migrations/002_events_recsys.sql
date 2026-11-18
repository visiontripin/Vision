CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE tracks ADD COLUMN embedding vector(512);
CREATE INDEX tracks_embedding_hnsw_idx ON tracks
  USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;

CREATE TABLE play_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  track_id uuid REFERENCES tracks(id) ON DELETE SET NULL,
  session_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('start', 'play_30s', 'finish', 'skip_early', 'repeat', 'segment_skip')),
  position_ms integer CHECK (position_ms IS NULL OR position_ms >= 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  source text NOT NULL CHECK (source IN ('wave', 'library', 'playlist', 'share', 'promo')),
  device text,
  ip_hash bytea,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK (duration_ms IS NULL OR position_ms IS NULL OR position_ms <= duration_ms + 60_000)
);
CREATE INDEX play_events_user_time_idx ON play_events(user_id, occurred_at DESC);
CREATE INDEX play_events_track_kind_idx ON play_events(track_id, kind, occurred_at DESC);
CREATE INDEX play_events_session_idx ON play_events(session_id, occurred_at);

CREATE TABLE taste_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  centroid vector(512),
  genre_weights jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(genre_weights) = 'object'),
  mood_weights jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(mood_weights) = 'object'),
  artist_affinity jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(artist_affinity) = 'object'),
  fatigue jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(fatigue) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recsys_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version text NOT NULL,
  dataset_version text NOT NULL,
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
