import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, notesFromChangelog, KNOWN_PLATFORMS } from './make-update-manifest.mjs';

/**
 * Манифест обновлений (I4) — тот файл, из которого приложение узнаёт о новой
 * версии. Ошибка здесь не видна до релиза, поэтому проверяем заранее:
 *  - заметки — одна строка, а не весь раздел CHANGELOG;
 *  - платформа без подписи не попадает в манифест;
 *  - адрес собирается из тега и имени артефакта, а не «как получилось».
 */

const base = {
  version: '0.3.0',
  tag: 'desktop-v0.3.0',
  repo: 'visiontripin/Vision',
  notes: 'Плашка обновлений',
  pubDate: '2026-11-11T09:00:00Z',
};

test('манифест: платформы, подписи и адреса артефактов', () => {
  const manifest = buildManifest({
    ...base,
    platforms: {
      'linux-x86_64': { artifact: 'Vision.Audio_0.3.0_amd64.AppImage.tar.gz', signature: ' sig-linux\n' },
      'windows-x86_64': { artifact: 'Vision.Audio_0.3.0_x64-setup.nsis.zip', signature: 'sig-win' },
      // без подписи — платформа пропускается, а не публикуется «на авось»
      'darwin-aarch64': { artifact: 'app.tar.gz', signature: '' },
    },
  });

  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest.pub_date, '2026-11-11T09:00:00Z');
  assert.equal(manifest.notes, 'Плашка обновлений');
  assert.equal(Object.keys(manifest.platforms).length, 2);
  assert.equal(manifest.platforms['linux-x86_64'].signature, 'sig-linux');
  assert.equal(
    manifest.platforms['linux-x86_64'].url,
    'https://github.com/visiontripin/Vision/releases/download/desktop-v0.3.0/Vision.Audio_0.3.0_amd64.AppImage.tar.gz'
  );
  assert.equal(manifest.platforms['darwin-aarch64'], undefined);
});

test('манифест: без единой подписанной платформы — ошибка, а не пустой файл', () => {
  assert.throws(
    () => buildManifest({ ...base, platforms: { 'linux-x86_64': { artifact: 'a.tar.gz', signature: '' } } }),
    /нет ни одной подписанной платформы/
  );
  assert.throws(() => buildManifest({ ...base, platforms: null }), /нет ни одной подписанной/);
});

test('манифест: кривые версия, тег, репозиторий и платформа отсекаются', () => {
  const platforms = { 'linux-x86_64': { artifact: 'a.tar.gz', signature: 's' } };
  assert.throws(() => buildManifest({ ...base, version: 'последняя', platforms }), /некорректная версия/);
  assert.throws(() => buildManifest({ ...base, tag: '', platforms }), /нужны --tag и --repo/);
  assert.throws(() => buildManifest({ ...base, repo: 'just-a-name', platforms }), /нужны --tag и --repo/);
  assert.throws(
    () => buildManifest({ ...base, platforms: { 'solaris-sparc': { artifact: 'a', signature: 's' } } }),
    /неизвестная платформа/
  );
});

test('манифест: ключи платформ совпадают с тем, что понимает Tauri', () => {
  assert.deepEqual(KNOWN_PLATFORMS, [
    'linux-x86_64', 'linux-aarch64',
    'windows-x86_64', 'windows-aarch64',
    'darwin-x86_64', 'darwin-aarch64',
  ]);
});

test('заметки из CHANGELOG: только первый абзац и одна строка', () => {
  const changelog = [
    '# Changelog',
    '',
    '## 0.3.0 — 2026-11-11',
    '',
    'Первая строка про обновления, довольно длинная, чтобы проверить обрезку по словам и многоточие в конце.',
    '',
    '### Детали',
    '- пункт, который в плашке не нужен',
    '- ещё один пункт',
    '',
    '## 0.2.0 — 2026-11-01',
    '',
    'Старое.',
  ].join('\n');

  const notes = notesFromChangelog(changelog, { maxLength: 60 });
  assert.ok(notes.length <= 61, `длина ${notes.length}`);
  assert.match(notes, /^Первая строка/);
  assert.doesNotMatch(notes, /пункт, который/);
  assert.doesNotMatch(notes, /###/);
  assert.doesNotMatch(notes, /\n/);

  // короткий раздел отдаётся целиком
  assert.equal(notesFromChangelog('## 0.3.0\n\nКоротко.\n\n## 0.2.0\n\nСтарое.'), 'Коротко.');
  assert.equal(notesFromChangelog(''), '');
  assert.equal(notesFromChangelog('без заголовков'), '');
});
