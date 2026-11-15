// @ts-check

/**
 * Safe default: no rights fingerprint provider has been selected. This adapter
 * reports that the check was not run and never declares a recording clear.
 */
export class UnconfiguredFingerprintAdapter {
  name = 'unconfigured';

  async inspect() {
    return { status: 'not_configured', matchCount: null };
  }
}

/** Provider-neutral contract guard for replaceable fingerprint integrations. */
export function requireFingerprintAdapter(adapter) {
  if (!adapter || typeof adapter.inspect !== 'function') {
    throw new Error('A fingerprint adapter implementing inspect() is required.');
  }
  return adapter;
}
