/**
 * Проверки конфигурации сетевого listener до импорта db.js и открытия файлов.
 * Legacy пароль `vision` можно оставить только на loopback; для сетевого bind
 * владелец должен явно задать пароль или включить защищённую first-run настройку.
 */

/** @param {string | undefined | null} value */
export function isLoopbackHost(value) {
  let host = String(value ?? '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host === '::1') return true;

  const octets = host.split('.');
  if (octets.length !== 4 || octets[0] !== '127') return false;
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/**
 * Development entry point defaults to loopback; production retains its
 * container-friendly all-interface bind and is guarded by inspectListenerConfig.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function applyDefaultListenerHost(env = process.env) {
  if (!env.HOST) env.HOST = env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
  return env.HOST;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: true, host: string, warning: string | null } | { ok: false, host: string, message: string }}
 */
export function inspectListenerConfig(env = process.env) {
  const host = String(env.HOST || '0.0.0.0').trim() || '0.0.0.0';
  const hasPassword = Boolean(String(env.VISION_PASSWORD || '').trim());
  const hasPasswordFile = Boolean(String(env.VISION_PASSWORD_FILE || '').trim());

  if (!isLoopbackHost(host) && !hasPassword && !hasPasswordFile) {
    return {
      ok: false,
      host,
      message: [
        `Refusing to listen on non-loopback host ${host} without explicit credentials.`,
        'Set VISION_PASSWORD to a unique secret or configure VISION_PASSWORD_FILE for one-time local setup.',
        'For local-only access, set HOST=127.0.0.1. The legacy default password is not safe on a network.',
      ].join(' '),
    };
  }

  return {
    ok: true,
    host,
    warning: !hasPassword && !hasPasswordFile
      ? 'WARNING: the legacy default owner password is active. The API is loopback-only; set VISION_PASSWORD to a unique secret before changing HOST.'
      : null,
  };
}
