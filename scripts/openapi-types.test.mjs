import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPENAPI } from '../services/api/src/openapi.js';

const generated = readFileSync(new URL('../packages/shared/src/generated/openapi.d.ts', import.meta.url), 'utf8');

test('OpenAPI document is the 3.1 source of generated client contract types', () => {
  assert.equal(OPENAPI.openapi, '3.1.0');
  assert.match(generated, /export interface paths/);
  assert.match(generated, /"\/setup"/);
  assert.match(generated, /"\/health"/);
});
