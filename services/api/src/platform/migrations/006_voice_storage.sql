-- Keep generated voice objects private in S3-compatible storage and account for
-- their MIME type without binding the schema to a TTS vendor.
ALTER TABLE tts_cache
  ADD COLUMN object_key text,
  ADD COLUMN content_type text NOT NULL DEFAULT 'application/octet-stream'
    CHECK (content_type = 'application/octet-stream' OR content_type ~ '^audio/[a-z0-9.+-]{1,64}$');
ALTER TABLE tts_cache ALTER COLUMN content_type DROP DEFAULT;
CREATE UNIQUE INDEX tts_cache_object_key_idx ON tts_cache(object_key) WHERE object_key IS NOT NULL;
CREATE INDEX tts_cache_created_idx ON tts_cache(created_at DESC);
