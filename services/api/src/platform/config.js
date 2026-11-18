// @ts-check

/**
 * Platform server defaults are loopback-only. A deployment must explicitly set
 * PLATFORM_HOST to bind another interface; local Docker keeps that bind inside
 * the container and publishes the host port on 127.0.0.1 only.
 * @param {Record<string, string | undefined>} [env]
 */
export function getPlatformServerConfig(env = process.env) {
  const port = Number(env.PLATFORM_PORT || 4400);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PLATFORM_PORT must be an integer between 1 and 65535.');
  }
  const maxUploadBytes = Number(env.PLATFORM_UPLOAD_MAX_BYTES || 200 * 1024 * 1024);
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) {
    throw new Error('PLATFORM_UPLOAD_MAX_BYTES must be a positive safe integer.');
  }
  return {
    host: env.PLATFORM_HOST || '127.0.0.1',
    port,
    registrationEnabled: env.PLATFORM_REGISTRATION_ENABLED === '1',
    uploadsEnabled: env.PLATFORM_UPLOADS_ENABLED === '1',
    maxUploadBytes,
  };
}
