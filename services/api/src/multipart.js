/**
 * Разбор `multipart/form-data` потоком (Фаза 3, H4 — загрузка с телефона).
 *
 * Зачем это вообще нужно, если тело-файл проще: в React Native файл с диска
 * отправляется только через `FormData({uri, name, type})`, то есть multipart.
 * Читать 300 МБ в память на телефоне, чтобы «привести к нашему формату», нельзя,
 * поэтому сервер принимает **оба** вида: обычное тело-файл (веб) и multipart с
 * одной частью (телефон).
 *
 * Разбор потоковый и однопроходный: никаких зависимостей и никакой буферизации
 * всего тела. Единственная часть возвращается как поток байтов — ровно того же
 * вида, что `req`, поэтому `handleUpload` читает её, не зная про multipart.
 *
 * Ограничения сознательные: разбираем только первую часть (телефон кладёт один
 * файл), другие пропускаем. Это не универсальный парсер — это «принять файл с
 * телефона, не уронив сервер».
 */

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

/** `multipart/form-data; boundary=----x` → `----x`; null, если это не multipart. */
export function boundaryOf(contentType) {
  const value = String(contentType ?? '');
  if (!/^multipart\/form-data/i.test(value)) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(value);
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  return boundary || null;
}

/**
 * Поток байтов первой части multipart.
 *
 * Возвращает объект с `stream` (асинхронный итератор чанков), `mime` и `filename`
 * из заголовков части. Если тело не похоже на multipart — `null`, и вызывающий
 * обрабатывает его как обычный файл.
 */
export function firstPartStream(source, contentType) {
  const boundary = boundaryOf(contentType);
  if (!boundary) return null;

  const delimiter = Buffer.from(`--${boundary}`);
  const separator = Buffer.concat([CRLF, delimiter]);
  const iterator = source[Symbol.asyncIterator]();

  let buffer = Buffer.alloc(0);
  let started = false;   // нашли открывающую границу
  let finished = false;  // нашли закрывающую
  let inHeaders = true;
  let mime = 'application/octet-stream';
  let filename = null;
  let pending = [];      // чанки тела, ещё не отданные наружу

  /**
   * Ищем в буфере разделитель. Отдаём всё, что заведомо левее возможного
   * разделителя: хвост длиной `separator.length` может оказаться его началом,
   * и его нельзя отправлять потребителю, пока не прочитан следующий чанк.
   */
  const drain = async function* () {
    while (true) {
      const index = buffer.indexOf(separator);
      if (index >= 0) {
        const body = buffer.subarray(0, index);
        buffer = buffer.subarray(index + separator.length);
        if (body.length) yield body;
        finished = true;
        return;
      }
      const safe = buffer.length - separator.length;
      if (safe > 0) {
        yield buffer.subarray(0, safe);
        buffer = buffer.subarray(safe);
      }
      const next = await iterator.next();
      if (next.done) {
        // тело кончилось без закрывающей границы — отдаём остаток как есть:
        // обрезанный файл сервер отвергнет по сигнатуре, а не по парсеру
        if (buffer.length) yield buffer;
        finished = true;
        return;
      }
      buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value;
    }
  };

  const stream = {
    async *[Symbol.asyncIterator]() {
      while (!finished) {
        if (!started) {
          const index = buffer.indexOf(delimiter);
          if (index < 0) {
            const next = await iterator.next();
            if (next.done) return;
            buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value;
            continue;
          }
          // всё до первой границы — служебный мусор (preamble), выбрасываем
          buffer = buffer.subarray(index + delimiter.length);
          started = true;
          // после границы идёт CRLF, затем заголовки части
          if (buffer.subarray(0, 2).equals(CRLF)) buffer = buffer.subarray(2);
          continue;
        }

        if (inHeaders) {
          const end = buffer.indexOf(HEADER_END);
          if (end < 0) {
            const next = await iterator.next();
            if (next.done) return;
            buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value;
            continue;
          }
          const raw = buffer.subarray(0, end).toString('utf8');
          buffer = buffer.subarray(end + HEADER_END.length);
          inHeaders = false;
          for (const line of raw.split('\r\n')) {
            const match = /^content-type:\s*(.+)$/i.exec(line);
            if (match) mime = match[1].trim();
            // имя файла из Content-Disposition — только для логов и подсказок:
            // метаданные сервер берёт из query, а теги — из самого файла
            const file = /filename="([^"]*)"/i.exec(line);
            if (file) filename = file[1] || null;
          }
          continue;
        }

        for await (const chunk of drain()) yield chunk;
      }
    },
  };

  return {
    stream,
    get mime() { return mime; },
    get filename() { return filename; },
    get boundary() { return boundary; },
    /** Дочитать до конца: иначе сокет останется с непрочитанным телом. */
    async discard() {
      try {
        for await (const _ of stream) { /* выбрасываем */ }
      } catch {
        /* клиент оборвал соединение — это не наша ошибка */
      }
    },
  };
}
