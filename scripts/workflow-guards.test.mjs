/**
 * Workflow guards: мобильный APK остаётся клиентом, frozen-платформы не запускаются
 * автоматически, а активный CI содержит OpenAPI type/smoke gates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const parseWorkflow = (text) => yaml.parse(text);
const androidText = read('.github/workflows/android.yml');
const consoleText = read('.github/workflows/console.yml');
const desktopText = read('.github/workflows/desktop.yml');
const ciText = read('.github/workflows/ci.yml');
const android = parseWorkflow(androidText);
const consoleWorkflow = parseWorkflow(consoleText);
const desktopWorkflow = parseWorkflow(desktopText);
const ciWorkflow = parseWorkflow(ciText);

test('Android workflow builds only the Vision Audio player', () => {
  assert.deepEqual(android.on.push.tags, ['android-v*']);
  assert.equal(android.on.workflow_dispatch.inputs.embedded, undefined);
  assert.equal(android.on.workflow_dispatch.inputs.tester, undefined);
  assert.equal(android.jobs.tester, undefined);
  assert.doesNotMatch(androidText, /nodejs-mobile|android-embed-node|fetch-nodejs-mobile|VisionTester/);
});

test('APK check rejects bundled Node, JNI server and server bootstrap', () => {
  assert.match(androidText, /libnode/);
  assert.match(androidText, /libvisionnode/);
  assert.match(androidText, /nodejs-project\//);
  assert.match(androidText, /VisionNodeService/);
  const check = android.jobs.apk.steps.find((step) => step.name === 'Проверка APK');
  assert.ok(check, 'APK validation step is missing');
  const pattern = check.run.match(/grep -Eq '([^']+)'/)?.[1];
  assert.ok(pattern, 'APK server-artifact grep expression is missing');
  const rejectsServerArtifacts = new RegExp(pattern);
  for (const entry of [
    'lib/arm64-v8a/libnode.so',
    'lib/arm64-v8a/libvisionnode.so',
    'assets/nodejs-project/bin/node',
    'assets/VisionNodeService',
    'assets/node.exe',
  ]) {
    assert.match(entry, rejectsServerArtifacts, `APK guard did not reject ${entry}`);
  }
  assert.doesNotMatch('assets/nodeXexe', rejectsServerArtifacts);
  assert.doesNotMatch('lib/arm64-v8a/libvision.so', rejectsServerArtifacts);
  assert.match(androidText, /index\.android\.bundle/);
  assert.match(androidText, /applicationId отличается от app\.vision\.audio/);
});

test('Android release requires an explicit tag or manual opt-in', () => {
  const publish = android.jobs.apk.steps.find((step) => step.name === 'Публикация Release');
  assert.ok(publish);
  assert.equal(android.on.workflow_dispatch.inputs.release.default, false);
  assert.match(publish.if, /startsWith\(github\.ref, 'refs\/tags\/android-v'\)/);
  assert.match(publish.if, /inputs\.release/);
});

test('active CI checks API, web, platform integrations and Android client before API smoke', () => {
  assert.equal(ciWorkflow.jobs.mobile.name, 'Android client typecheck');
  assert.equal(ciWorkflow.jobs.mobile.defaults.run['working-directory'], 'apps/mobile');
  assert.ok(ciWorkflow.jobs.mobile.steps.some((step) => step.run === 'npx tsc --noEmit'));
  assert.deepEqual(ciWorkflow.jobs['platform-integration'].needs, ['test']);
  assert.match(ciWorkflow.jobs['platform-integration'].services.postgres.image, /pgvector.*pg16/);
  const minioStep = ciWorkflow.jobs['platform-integration'].steps.find((step) => step.name === 'Start private MinIO test service');
  assert.ok(minioStep);
  assert.match(minioStep.run, /docker run --detach.*\\\n.*-p 9000:9000/);
  assert.deepEqual(ciWorkflow.jobs.smoke.needs, ['test', 'mobile', 'platform-integration']);
  assert.equal(ciWorkflow.permissions.contents, 'read');
  assert.match(ciText, /npm run check:api-types/);
  assert.match(ciText, /npm run typecheck:api/);
  assert.match(ciText, /api\/v1\/openapi\.json/);
  assert.match(ciText, /Health and OpenAPI smoke passed/);
});

test('desktop and console workflows are frozen, manual-only and cannot publish', () => {
  const workflows = [
    [consoleWorkflow, consoleText, ['check', 'windows', 'android']],
    [desktopWorkflow, desktopText, ['linux', 'windows']],
  ];
  for (const [workflow, text, jobs] of workflows) {
    assert.ok(workflow.on.workflow_dispatch.inputs.validate);
    assert.equal(workflow.on.workflow_dispatch.inputs.validate.default, false);
    assert.equal(workflow.on.push, undefined);
    assert.equal(workflow.on.pull_request, undefined);
    assert.equal(workflow.permissions.contents, 'read');
    assert.match(text, /ADR-0016/);
    assert.doesNotMatch(text, /contents: write/);
    for (const name of jobs) {
      assert.equal(workflow.jobs[name].if, '${{ inputs.validate }}');
    }
    const publishSteps = Object.values(workflow.jobs)
      .flatMap((job) => job.steps || [])
      .filter((step) => /^(Release|Манифест обновлений)/.test(String(step.name || '')));
    assert.ok(publishSteps.length > 0);
    for (const step of publishSteps) assert.equal(step.if, false);
  }
  assert.equal(consoleWorkflow.jobs.windows.needs, 'check');
  // Existing installer sources are retained for history/audit, not run by normal CI.
  assert.match(consoleText, /npm run build:windows/);
  assert.equal(existsSync(path.join(ROOT, 'apps/console/src-tauri/nsis/vision-service-hooks.nsh')), true);
  assert.equal(existsSync(path.join(ROOT, 'apps/console/scripts/prepare-server.mjs')), true);
});

test('mobile UI removes embedded server controls and keeps external API connection', () => {
  const mobileFiles = [
    'apps/mobile/App.tsx',
    'apps/mobile/src/screens/MainScreen.tsx',
    'apps/mobile/src/screens/SettingsScreen.tsx',
  ].map(read).join('\n');
  assert.doesNotMatch(mobileFiles, /startEmbeddedServer|ServerStatusScreen|onOpenEmbedded|isRuntimeAvailable/);
  assert.match(read('apps/mobile/src/screens/MainScreen.tsx'), /ServerScreen/);
  assert.match(read('apps/mobile/src/screens/ServerScreen.tsx'), /api\.login/);
  assert.equal(JSON.parse(read('apps/mobile/app.json')).expo.android.package, 'app.vision.audio');
  assert.doesNotMatch(read('apps/mobile/app.json'), /FOREGROUND_SERVICE_DATA_SYNC/);
});

test('removed Android server build scripts cannot be called by a workflow', () => {
  for (const file of [
    'apps/mobile/nodejs',
    'scripts/android-embed-node.mjs',
    'scripts/fetch-nodejs-mobile.mjs',
    '.github/workflows/android-embedded.yml',
  ]) {
    assert.equal(existsSync(path.join(ROOT, file)), false, `${file} still exists`);
  }
});
