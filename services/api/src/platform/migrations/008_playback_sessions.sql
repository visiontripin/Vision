-- Server-visible playback sessions allow revocation and make replay checks depend on
-- the issued session record, not only on a still-valid signed token. Tokens themselves
-- are never stored. Keep only minimal identity, track, issue/expiry, and revocation data.
CREATE TABLE playback_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id uuid NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + interval '1 hour')
);
CREATE INDEX playback_sessions_user_created_idx ON playback_sessions(user_id, created_at DESC);
CREATE INDEX playback_sessions_expiry_idx ON playback_sessions(expires_at);

-- Normalize historical retries before enforcing the milestone invariant. Keep the
-- earliest server-received event for each session; later retries cannot add listens.
WITH ranked_milestones AS (
  SELECT id, row_number() OVER (PARTITION BY session_id ORDER BY received_at, id) AS ordinal
  FROM play_events
  WHERE kind = 'play_30s'
)
DELETE FROM play_events AS event
USING ranked_milestones AS ranked
WHERE event.id = ranked.id AND ranked.ordinal > 1;

-- A qualified play is a session milestone, not a countable client event: retrying it
-- under a new event id must not inflate play_30s analytics for the same playback session.
CREATE UNIQUE INDEX play_events_play_30s_once_idx
  ON play_events(session_id) WHERE kind = 'play_30s';
