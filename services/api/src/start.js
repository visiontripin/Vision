/**
 * Точка входа с человеческими ошибками для «нестандартных» окружений
 * (прежде всего Android/Termux, где Node собран без встроенного SQLite).
 *
 * Сам сервер живёт в `server.js`; здесь только импорт и разбор типичных сбоев,
 * чтобы вместо простыни стека было понятно, что делать. Windows-служба читает
 * выбранный порт из отдельного файла настроек до импорта `server.js`.
 */

import { readFileSync } from 'node:fs';
import { applyDefaultListenerHost } from './startup-config.js';

// npm start is a developer entry point by default: bind locally unless a
// production/service deployment explicitly supplies HOST. Public binds still
// require explicit credentials in server-preflight.js.
applyDefaultListenerHost();

const settingsFile = process.env.VISION_SERVER_SETTINGS_FILE;
if (settingsFile) {
  try {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    const port = Number(settings?.port);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) process.env.PORT = String(port);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Некорректный файл настроек Vision Server (${settingsFile}): ${error.message}`);
    }
  }
}

function explain(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || error);

  if (/requires SQLite FTS5|no such module:\s*fts5/i.test(message)) {
    return [
      'SQLite в этой сборке Node не поддерживает FTS5, необходимый для миграции поиска.',
      'Обновите Node.js до версии 22.16.0 или новее и запустите сервер повторно.',
      `Исходная ошибка: ${message}`,
    ].join('\n');
  }

  if (message.includes('Refusing to listen on non-loopback host')) {
    return [
      'Запуск по сети отменён: legacy-пароль по умолчанию небезопасен.',
      'Укажите уникальный VISION_PASSWORD или VISION_PASSWORD_FILE для защищённой первоначальной настройки.',
      'Для локальной отладки задайте HOST=127.0.0.1.',
    ].join('\n');
  }

  if (code === 'ERR_UNKNOWN_BUILTIN_MODULE' || message.includes('node:sqlite')) {
    return [
      'В этой сборке Node нет встроенного модуля node:sqlite.',
      '',
      'Что делать:',
      '  • Termux: pkg upgrade nodejs  (нужен Node 22.16+, официальная сборка Termux)',
      '  • либо запустить сервер не на телефоне: Docker, мини-ПК, Raspberry Pi —',
      '    телефону оставить только web-интерфейс из GitHub Pages.',
    ].join('\n');
  }

  if (code === 'EADDRINUSE') {
    return [
      `Порт ${process.env.PORT || 4000} уже занят.`,
      '',
      'Что делать: остановить прошлый процесс (Ctrl+C в его терминале)',
      'или запустить на другом порту: PORT=4100 npm start',
    ].join('\n');
  }

  if (code === 'EACCES') {
    return [
      'Нет прав на файл или порт.',
      '',
      'Что делать: не запускайте от root и не храните данные в /sdcard —',
      'Termux не умеет chmod/rename на общей памяти. DATA_DIR должен быть в $HOME.',
    ].join('\n');
  }

  return null;
}

try {
  await import('./server.js');
} catch (error) {
  const hint = explain(error);
  if (!hint) throw error;

  console.error(`\n✖ Не удалось запустить Vision Audio\n\n${hint}\n\nИсходная ошибка: ${error?.message ?? error}\n`);
  process.exit(1);
}
