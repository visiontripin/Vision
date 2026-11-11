#!/usr/bin/env node
/**
 * Сборка манифеста обновлений `latest.json` (I4) для релиза десктопа.
 *
 * Формат — Tauri updater 2: версия, дата, заметки и платформы с подписью и адресом.
 * Скрипт отдельный, а не `python3 - <<EOF` внутри workflow, по двум причинам:
 *  - его можно проверить тестом (и проверить заранее, до релиза);
 *  - ошибка в отступе heredoc ломает публикацию молча, а ошибка скрипта — громко.
 *
 *   node scripts/make-update-manifest.mjs \
 *     --version 0.3.0 --tag desktop-v0.3.0 --repo owner/name \
 *     --notes-file CHANGELOG.md --out latest.json
 *
 * Платформы передаются флагами `--platform linux-x86_64=путь.tar.gz:путь.sig`.
 * Если подписи нет — платформа пропускается: обновление без подписи Tauri всё
 * равно отклонит, и публиковать его в манифесте нельзя.
 */
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Ключи платформ, которые понимает Tauri updater. */
export const KNOWN_PLATFORMS = [
  'linux-x86_64',
  'linux-aarch64',
  'windows-x86_64',
  'windows-aarch64',
  'darwin-x86_64',
  'darwin-aarch64',
];

/**
 * Заметки для плашки: первый абзац раздела CHANGELOG этой версии, одна строка.
 * Полный раздел занимает килобайты, а в плашке видна одна строка — класть в
 * манифест весь текст значит отдавать людям то, что они не прочитают.
 */
export function notesFromChangelog(changelog, { maxLength = 240 } = {}) {
  const lines = String(changelog ?? '').split('\n');
  const start = lines.findIndex((line) => /^## \d+\.\d+\.\d+/.test(line.trim()));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \d+\.\d+\.\d+/.test(line.trim()));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n');

  const paragraph = body
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('###') && !line.trim().startsWith('- '))
    .join(' ')
    .trim();

  if (paragraph.length <= maxLength) return paragraph;
  const cut = paragraph.slice(0, maxLength);
  return `${cut.slice(0, Math.max(0, cut.lastIndexOf(' ')))}…`;
}

export function buildManifest({ version, tag, repo, platforms, notes = '', pubDate = null }) {
  if (!version || !/^\d+\.\d+\.\d+/.test(String(version))) {
    throw new Error(`некорректная версия: ${version}`);
  }
  if (!tag || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('нужны --tag и --repo owner/name');
  }

  const entries = {};
  for (const [platform, target] of Object.entries(platforms ?? {})) {
    if (!KNOWN_PLATFORMS.includes(platform)) {
      throw new Error(`неизвестная платформа: ${platform}`);
    }
    if (!target.signature || !target.artifact) continue;
    entries[platform] = {
      signature: String(target.signature).trim(),
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(target.artifact)}`,
    };
  }
  if (!Object.keys(entries).length) {
    throw new Error('нет ни одной подписанной платформы — манифест публиковать нельзя');
  }

  return {
    version: String(version),
    pub_date: pubDate || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    notes: String(notes || '').trim() || `Vision Audio ${version}`,
    platforms: entries,
  };
}

/* ------------------------------- CLI ------------------------------------- */

function parseArgs(argv) {
  const args = { platforms: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith('--')) continue;
    if (key === '--platform') {
      const [name, files] = String(value || '').split('=');
      const [artifact, signatureFile] = String(files || '').split(':');
      args.platforms[name] = { artifact, signatureFile };
      i += 1;
      continue;
    }
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const platforms = {};
  for (const [name, target] of Object.entries(args.platforms)) {
    const signaturePath = path.resolve(cwd, target.signatureFile || '');
    const artifactName = path.basename(target.artifact || '');
    if (!artifactName || !existsSync(signaturePath)) {
      console.warn(`⚠ ${name}: нет подписи (${target.signatureFile}) — платформа пропущена`);
      continue;
    }
    if (!existsSync(path.resolve(cwd, target.artifact))) {
      console.warn(`⚠ ${name}: нет файла ${target.artifact} — платформа пропущена`);
      continue;
    }
    platforms[name] = { artifact: artifactName, signature: readFileSync(signaturePath, 'utf8') };
  }

  const notes = args['notes-file'] && existsSync(args['notes-file'])
    ? notesFromChangelog(readFileSync(args['notes-file'], 'utf8'))
    : '';

  const manifest = buildManifest({
    version: args.version,
    tag: args.tag,
    repo: args.repo,
    platforms,
    notes,
  });

  const out = args.out || 'latest.json';
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  const size = statSync(out).size;
  console.log(`✓ ${out} — ${manifest.version}, платформ: ${Object.keys(manifest.platforms).length} (${size} Б)`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  try {
    main();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
