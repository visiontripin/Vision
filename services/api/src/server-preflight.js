import { inspectListenerConfig } from './startup-config.js';
import { assertFts5Available } from './runtime-checks.js';

const listener = inspectListenerConfig();
if (listener.ok === false) throw new Error(listener.message);
if (listener.warning) console.warn(listener.warning);

assertFts5Available();
