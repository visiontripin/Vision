#!/usr/bin/env node
/**
 * Generate the shared TypeScript view of the API contract from the runtime OpenAPI
 * document. Keep services/api/src/openapi.js as the single source of truth.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { OPENAPI } from '../services/api/src/openapi.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'packages/shared/src/generated/openapi.d.ts');
const checkOnly = process.argv.includes('--check');

const ast = await openapiTS(OPENAPI, { alphabetize: true });
const generated = astToString(ast);

if (checkOnly) {
  let existing;
  try {
    existing = await readFile(OUTPUT, 'utf8');
  } catch {
    console.error(`Missing generated API types: ${path.relative(ROOT, OUTPUT)}`);
    console.error('Run `npm run generate:api-types` and commit the result.');
    process.exitCode = 1;
  }
  if (existing !== undefined && existing !== generated) {
    console.error(`Generated API types are stale: ${path.relative(ROOT, OUTPUT)}`);
    console.error('Run `npm run generate:api-types` and commit the result.');
    process.exitCode = 1;
  }
} else {
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, generated);
  console.log(`Generated ${path.relative(ROOT, OUTPUT)}`);
}
