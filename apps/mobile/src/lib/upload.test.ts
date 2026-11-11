import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BATCH, MAX_UPLOAD_BYTES, buildUploadPlan, extOf, guessMeta, mimeForFile,
  parseUploadResponse, progressLabel, validatePicked,
} from './upload.ts';

/**
 * Загрузка с телефона (H4) — правила, которые решаются до сети.
 *
 * На устройстве отлаживать «почему сервер ответил 415» дорого, поэтому всё, что
 * можно решить заранее, решается в чистой функции: тип, размер, метаданные,
 * формат запроса. Здесь же — разбор ответа: «дубликат» это не сбой.
 */

test('расширение из имени, регистр и отсутствие расширения', () => {
  assert.equal(extOf('Track.MP3'), 'mp3');
  assert.equal(extOf('запись_2026-11-11.m4a'), 'm4a');
  assert.equal(extOf('без расширения'), null);
  assert.equal(extOf(''), null);
  assert.equal(extOf(null), null);
});

test('mime: системный верный — берём его, врущий — побеждает расширение', () => {
  assert.equal(mimeForFile({ uri: 'file:///a.mp3', name: 'a.mp3', mimeType: 'audio/mpeg' }), 'audio/mpeg');
  // Android часто присылает audio/mpeg для m4a — расширение надёжнее
  assert.equal(mimeForFile({ uri: 'file:///a.m4a', name: 'a.m4a', mimeType: 'audio/mpeg' }), 'audio/mp4');
  // content:// без имени, но с mime
  assert.equal(mimeForFile({ uri: 'content://media/1234', mimeType: 'audio/x-flac' }), 'audio/x-flac');
  // совсем ничего не известно — решает сигнатура на сервере
  assert.equal(mimeForFile({ uri: 'content://media/1234' }), 'application/octet-stream');
});

test('метаданные из имени: «Artist - Title» и подчёркивания диктофона', () => {
  assert.deepEqual(guessMeta('Nils Frahm - Says.mp3'), { title: 'Says', artist: 'Nils Frahm' });
  assert.deepEqual(guessMeta('REC_20261111_1930.m4a'), { title: 'REC 20261111 1930', artist: null });
  // дефис в названии: артист отделяется только по первому « - »
  assert.deepEqual(guessMeta('Kite - Night Bus - Live.mp3'), { title: 'Night Bus - Live', artist: 'Kite' });
  assert.deepEqual(guessMeta(''), { title: 'Без названия', artist: null });
});

test('проверка до отправки: те же коды, что у сервера', () => {
  assert.equal(validatePicked(null).ok, false);
  assert.deepEqual(validatePicked(null), { ok: false, code: 'no_file', message: 'Файл не выбран.' });

  const txt = validatePicked({ uri: 'file:///notes.txt', name: 'notes.txt', mimeType: 'text/plain' });
  assert.equal(txt.ok, false);
  assert.equal(!txt.ok && txt.code, 'unsupported_type');

  const big = validatePicked({ uri: 'file:///big.wav', name: 'big.wav', size: MAX_UPLOAD_BYTES + 1 });
  assert.equal(!big.ok && big.code, 'too_large');

  const empty = validatePicked({ uri: 'file:///empty.mp3', name: 'empty.mp3', size: 0 });
  assert.equal(!empty.ok && empty.code, 'empty_file');

  assert.equal(validatePicked({ uri: 'file:///a.mp3', name: 'a.mp3', size: 1024 }).ok, true);
  // размер неизвестен (iOS иногда не даёт) — не мешаем отправке
  assert.equal(validatePicked({ uri: 'file:///a.m4a', name: 'a.m4a' }).ok, true);
});

test('план запроса: тело — файл, метаданные в query, пустые поля не отправляются', () => {
  const plan = buildUploadPlan(
    { uri: 'file:///Nils Frahm - Says.flac', name: 'Nils Frahm - Says.flac', size: 4096 },
    { title: '', artist: '', album: '  ', genre: 'Ambient', duration: 341.6 }
  );
  const params = new URL(plan.path, 'http://x').searchParams;

  assert.equal(plan.mime, 'audio/flac');
  assert.equal(plan.ext, 'flac');
  assert.equal(plan.bytes, 4096);
  // пустой title берётся из имени файла, пустой artist — из «Artist - Title»
  assert.equal(params.get('title'), 'Says');
  assert.equal(params.get('artist'), 'Nils Frahm');
  assert.equal(params.get('genre'), 'Ambient');
  assert.equal(params.get('duration'), '342', 'длительность округляется до секунд');
  // пустой альбом не передаём: иначе сервер сотрёт тег из файла
  assert.equal(params.has('album'), false);
});

test('план запроса: имя без метаданных не ломает адрес', () => {
  const plan = buildUploadPlan({ uri: 'content://media/42', mimeType: 'audio/mpeg' }, { title: '' });
  assert.match(plan.path, /^\/api\/tracks\?/);
  assert.equal(new URL(plan.path, 'http://x').searchParams.get('title'), 'Без названия');
  assert.equal(plan.ext, 'mp3');
});

test('ответ сервера: дубликат — не ошибка, а «уже есть»', () => {
  const uploaded = parseUploadResponse(201, { id: 'abc', title: 'Says' });
  assert.deepEqual(uploaded, { kind: 'uploaded', id: 'abc', title: 'Says' });

  const duplicate = parseUploadResponse(409, {
    error: { code: 'duplicate', message: 'Этот файл уже есть в библиотеке.' },
    existing: { id: 'abc', title: 'Says' },
  });
  assert.deepEqual(duplicate, { kind: 'duplicate', id: 'abc', title: 'Says' });

  const failed = parseUploadResponse(415, {
    error: { code: 'unsupported_type', message: 'Это не похоже на аудиофайл.' },
  });
  assert.deepEqual(failed, { kind: 'failed', code: 'unsupported_type', message: 'Это не похоже на аудиофайл.' });

  // сервер упал без тела — всё равно понятное сообщение, а не «undefined»
  const crashed = parseUploadResponse(500, null);
  assert.equal(crashed.kind, 'failed');
  assert.match(!crashed || crashed.kind === 'failed' ? crashed.message : '', /500/);

  assert.equal(MAX_BATCH, 20, 'очередь ограничена, чтобы не переполнить память');
});

test('прогресс очереди говорит «3 из 5», а не проценты', () => {
  assert.equal(progressLabel(0, 5), '0 из 5');
  assert.equal(progressLabel(3, 5), '3 из 5');
  assert.equal(progressLabel(5, 5), 'Готово: 5');
  assert.equal(progressLabel(0, 0), '');
});
