/**
 * Логика встроенного тестера API: набор проверок, разбор ответов и итог.
 *
 * Вынесено из экрана, чтобы проверялось `node:test` — без телефона и без сети.
 * Экран (`TesterScreen`) только рисует то, что здесь посчитано.
 */

export type CheckStatus = 'ok' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** HTTP-код, если запрос дошёл */
  http?: number;
  /** сколько заняло, мс */
  ms?: number;
  /** короткое объяснение для человека */
  detail: string;
}

export interface CheckSpec {
  id: string;
  title: string;
  method: 'GET' | 'HEAD' | 'PUT' | 'DELETE' | 'POST';
  path: string;
  /** тело запроса для PUT */
  body?: (ctx: TesterContext) => Uint8Array | string;
  headers?: Record<string, string>;
  /** какие коды считать успехом */
  expect?: number[];
  /** что проверить в ответе; возвращает текст ошибки или null */
  validate?: (payload: unknown, response: { status: number; text: string }) => string | null;
  /** для чего проверка — показывается серым */
  why: string;
}

export interface TesterContext {
  /** адрес сервера без хвостового слэша */
  base: string;
  /** токен, если сервер его требует */
  token?: string | null;
  /** имя файла для проверки загрузки */
  fileName?: string;
  /** содержимое для проверки загрузки */
  fileBody?: Uint8Array;
}

/** Минимальный валидный «аудиофайл» для проверки загрузки: не пустой и с тегом.
 * Только ASCII-байты: не полагаемся на глобальный TextEncoder, которого может не
 * быть в некоторых версиях Hermes/React Native (этот модуль импортируется уже
 * при старте плеера, до открытия экрана тестера).
 */
export function sampleAudio(): Uint8Array {
  const payload = new Uint8Array(256);
  payload[0] = 0x49; // I
  payload[1] = 0x44; // D
  payload[2] = 0x33; // 3
  for (let i = 3; i < payload.length; i += 1) payload[i] = i % 251;
  return payload;
}

/**
 * Набор проверок. Порядок важен: health → список → загрузка → чтение →
 * перемотка → удаление. Так тестер сам убирает за собой и не оставляет мусор в
 * библиотеке, даже если что-то посередине упало (удаление в конце).
 */
export function checks(ctx: TesterContext): CheckSpec[] {
  const name = ctx.fileName ?? 'tester-check.mp3';
  const body = ctx.fileBody ?? sampleAudio();
  return [
    {
      id: 'health',
      title: 'Сервер отвечает',
      method: 'GET',
      path: '/api/health',
      expect: [200],
      why: 'базовая проверка: процесс жив и HTTP-слой работает',
      validate: (payload) => {
        if (!payload || typeof payload !== 'object') return 'ответ не JSON';
        const value = payload as Record<string, unknown>;
        if (value.ok !== true && value.status !== 'ok') return 'в ответе нет ok: true';
        return null;
      },
    },
    {
      id: 'files',
      title: 'Список файлов',
      method: 'GET',
      path: '/api/files',
      expect: [200],
      why: 'чтение библиотеки: права, каталог данных, сериализация',
    },
    {
      id: 'upload',
      title: 'Загрузка файла',
      method: 'PUT',
      path: `/api/files/library/${name}`,
      expect: [200, 201, 204],
      why: 'тело-поток и запись на диск — самое частое место отказа',
      body: () => body,
      headers: { 'Content-Type': 'audio/mpeg' },
    },
    {
      id: 'download',
      title: 'Скачивание целиком',
      method: 'GET',
      path: `/files/library/${name}`,
      expect: [200],
      why: 'раздача файла: размер и тип содержимого',
      validate: (_payload, response) => {
        if (!response.text.length) return 'файл пустой';
        return null;
      },
    },
    {
      id: 'range',
      title: 'Перемотка (Range)',
      method: 'GET',
      path: `/files/library/${name}`,
      expect: [206],
      headers: { Range: 'bytes=0-15' },
      why: 'без 206 плеер не сможет перематывать трек',
      validate: (_payload, response) => {
        if (response.text.length > 16) return `пришло ${response.text.length} байт вместо 16`;
        return null;
      },
    },
    {
      id: 'delete',
      title: 'Удаление файла',
      method: 'DELETE',
      path: `/api/files/library/${name}`,
      expect: [200, 204, 404],
      why: 'уборка после проверки',
    },
  ];
}

/** Заголовки запроса: токен, если он есть, и ничего лишнего. */
export function headersFor(spec: CheckSpec, token?: string | null): Record<string, string> {
  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function checkUrl(base: string, spec: CheckSpec): string {
  const trimmed = String(base ?? '').replace(/\/+$/, '');
  return `${trimmed}${spec.path}`;
}

/**
 * Оценка ответа. Отдельно разбираем 401: это не «сломанный сервер», а самая
 * частая причина — не тот токен, и текст должен говорить именно это.
 */
export function judge(spec: CheckSpec, status: number, text: string, payload: unknown): CheckResult {
  const base: Omit<CheckResult, 'status' | 'detail'> = { id: spec.id, title: spec.title, http: status };
  const expected = spec.expect ?? [200];

  if (status === 401 || status === 403) {
    return { ...base, status: 'fail', detail: 'доступ запрещён: проверьте токен сервера' };
  }
  if (!expected.includes(status)) {
    const reason = status >= 500 ? `ошибка сервера ${status}` : `ожидался ${expected.join('/')}, пришёл ${status}`;
    // Тело ошибки часто содержит настоящую причину — показываем его хвост.
    const tail = text.trim().slice(0, 140);
    return { ...base, status: 'fail', detail: tail ? `${reason}: ${tail}` : reason };
  }
  if (spec.validate) {
    const problem = spec.validate(payload, { status, text });
    if (problem) return { ...base, status: 'fail', detail: problem };
  }
  return { ...base, status: 'ok', detail: 'ок' };
}

/** Итог: «всё зелёное» и одна строка для копирования в отчёт. */
export function summarize(results: CheckResult[], meta: { url: string; runtime?: string | null; version?: string | null }): {
  pass: number;
  fail: number;
  skip: number;
  total: number;
  headline: string;
  report: string;
} {
  const pass = results.filter((r) => r.status === 'ok').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  const total = results.length;

  const headline = fail === 0
    ? `Все проверки пройдены: ${pass} из ${total}`
    : `Проблемы: ${fail} из ${total}`;

  const lines = [
    `Vision Audio · тестер API`,
    `сервер: ${meta.url}`,
    meta.runtime ? `рантайм: ${meta.runtime}` : null,
    meta.version ? `версия: ${meta.version}` : null,
    '',
    ...results.map((r) => `${r.status === 'ok' ? '✓' : r.status === 'fail' ? '✗' : '–'} ${r.title}` +
      `${r.http ? ` [${r.http}]` : ''}${typeof r.ms === 'number' ? ` ${r.ms} мс` : ''} — ${r.detail}`),
    '',
    headline,
  ];
  return { pass, fail, skip, total, headline, report: lines.filter((line) => line !== null).join('\n') };
}

/**
 * Причина отказа «до сети не дошло»: `fetch` падает исключением, и от него надо
 * отличать программную ошибку от сетевой.
 */
export function networkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Network request failed|Failed to fetch|ECONNREFUSED|fetch failed/i.test(message)) {
    return 'сервер не принял соединение: возможно, он не запущен или слушает другой порт';
  }
  if (/timeout|aborted/i.test(message)) return 'сервер не ответил вовремя';
  return message || 'неизвестная ошибка';
}
