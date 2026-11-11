#!/usr/bin/env node
/**
 * Включает подпись артефактов обновления **только когда есть ключ** (I4).
 *
 * Зачем отдельный шаг, а не `createUpdaterArtifacts: true` в репозитории:
 * presence `pubkey` и `createUpdaterArtifacts` Tauri проверяет при сборке и
 * падает, если ключей нет. На PR секретов нет — значит конфиг в репозитории
 * обязан быть безобидным, а «настоящим» его делает CI на релизном теге.
 *
 * Использование (из корня репозитория, в CI):
 *   node scripts/enable-updater-signing.mjs                       # по наличию env
 *   node scripts/enable-updater-signing.mjs --config path.json    # другой файл
 *
 * Поведение:
 *  - `TAURI_SIGNING_PRIVATE_KEY` пуст → ничего не меняем, код возврата 0
 *    (сборка обычных установщиков продолжится, автообновления не будет);
 *  - ключ есть, а `TAURI_UPDATER_PUBKEY` пуст → код возврата 1: подписывать
 *    ключом без публичной части бессмысленно, приложение такое обновление
 *    отклонит. Лучше упасть в CI, чем выпустить релиз, который не обновится.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** Значение по умолчанию — конфиг десктопного приложения. */
export const DEFAULT_CONFIG = 'apps/desktop/src-tauri/tauri.conf.json';

/**
 * Возвращает новый конфиг (не мутирует вход). `null` — менять нечего.
 * @param {object} config
 * @param {{privateKey?: string, pubkey?: string}} env
 */
export function applyUpdaterSigning(config, env) {
  const privateKey = String(env.privateKey ?? '').trim();
  const pubkey = String(env.pubkey ?? '').trim();
  if (!privateKey) return null;
  if (!pubkey) {
    throw new Error(
      'есть TAURI_SIGNING_PRIVATE_KEY, но нет TAURI_UPDATER_PUBKEY — ' +
        'приложение отклонит обновление без публичного ключа'
    );
  }
  const next = JSON.parse(JSON.stringify(config));
  next.bundle = { ...(next.bundle ?? {}), createUpdaterArtifacts: true };
  next.plugins = { ...(next.plugins ?? {}) };
  next.plugins.updater = { ...(next.plugins.updater ?? {}), pubkey };
  return next;
}

function main(argv) {
  const args = argv.slice(2);
  const configIndex = args.indexOf('--config');
  const path = configIndex >= 0 ? args[configIndex + 1] : DEFAULT_CONFIG;
  if (!path) {
    console.error('✗ --config требует путь');
    return 2;
  }

  const config = JSON.parse(readFileSync(path, 'utf8'));
  let next;
  try {
    next = applyUpdaterSigning(config, {
      privateKey: process.env.TAURI_SIGNING_PRIVATE_KEY,
      pubkey: process.env.TAURI_UPDATER_PUBKEY,
    });
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (!next) {
    console.log('• Ключа подписи нет — собираем установщики без автообновления');
    return 0;
  }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  console.log('✓ Подпись обновлений включена (createUpdaterArtifacts + pubkey)');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
