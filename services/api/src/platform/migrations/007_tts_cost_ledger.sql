-- Append-only accounting for each real synthesis attempt. Raw script text and
-- generated audio are intentionally excluded from this ledger.
CREATE TABLE tts_generation_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_hash char(64) NOT NULL CHECK (cache_hash ~ '^[a-f0-9]{64}$'),
  script_id uuid NOT NULL REFERENCES radio_scripts(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  voice text NOT NULL CHECK (length(voice) BETWEEN 1 AND 100),
  cost_microunits bigint NOT NULL CHECK (cost_microunits >= 0),
  audio_bytes integer CHECK (audio_bytes IS NULL OR audio_bytes BETWEEN 1 AND 10485760),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 600000),
  outcome text NOT NULL CHECK (outcome IN ('stored', 'failed_after_synthesis')),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Za-z0-9_.-]{1,80}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'stored' AND failure_code IS NULL)
    OR (outcome = 'failed_after_synthesis' AND failure_code IS NOT NULL))
);
CREATE INDEX tts_generation_ledger_created_idx ON tts_generation_ledger(created_at DESC);
CREATE INDEX tts_generation_ledger_provider_idx ON tts_generation_ledger(provider, created_at DESC);
