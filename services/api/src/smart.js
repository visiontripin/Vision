/**
 * Умные плейлисты по правилам (Фаза 5, C7).
 *
 * Идея: плейлист — не список `id`, а **запрос**, который пересчитывается при
 * каждом открытии. Добавили трек с жанром «Ambient» — он сам попал в «Вечер».
 * Поэтому в таблице лежат правила, а не треки.
 *
 * Почему правила разбираются здесь, а не прямо в SQL-строке из запроса:
 * правила приходят из JSON, и `field`/`op` — это пользовательский ввод. Список
 * допустимых полей и операторов закрыт, значения уходят в запрос **только как
 * параметры** (`?`), поэтому подставить SQL через правило невозможно. Тесты на
 * это — в `services/api/test/smart.test.js`.
 *
 * Сортировка и лимит — тоже часть правил: «Топ-40 по прослушиваниям» — это
 * правило, а не вид страницы.
 */

/** Поля, по которым можно фильтровать. `column` — то, что попадёт в SQL. */
export const FIELDS = {
  genre: { type: 'text', column: 't.genre', ops: ['is', 'contains', 'empty', 'any'] },
  artist: { type: 'text', column: 't.artist', ops: ['is', 'contains', 'empty', 'any'] },
  album: { type: 'text', column: 't.album', ops: ['is', 'contains', 'empty', 'any'] },
  title: { type: 'text', column: 't.title', ops: ['contains', 'is'] },
  liked: { type: 'boolean', column: 't.liked', ops: ['is'] },
  year: { type: 'number', column: 'CAST(strftime(\'%Y\', t.created_at) AS INTEGER)', ops: ['gte', 'lte', 'eq'] },
  plays: { type: 'number', column: 't.plays', ops: ['gte', 'lte', 'eq'] },
  duration: { type: 'number', column: 't.duration', ops: ['gte', 'lte', 'eq'] },
  /** Свежие: добавлены не позже N дней назад. */
  addedDays: { type: 'number', column: "julianday('now') - julianday(t.created_at)", ops: ['lte'] },
  /**
   * Забытые: не слушались N дней (никогда — тоже «забытые», считаем 1e6 дней).
   * Выражение целиком, потому что колонки `days_since` в схеме нет.
   */
  notPlayedDays: {
    type: 'number',
    column: "COALESCE(julianday('now') - julianday(l.updated_at), 1000000)",
    ops: ['gte', 'lte'],
    joinListens: true,
  },
};

export const SORTS = {
  recent: 't.created_at DESC',
  oldest: 't.created_at ASC',
  title: 't.title COLLATE NOCASE ASC',
  artist: 't.artist COLLATE NOCASE ASC, t.title COLLATE NOCASE ASC',
  plays: 't.plays DESC, t.created_at DESC',
  duration: 't.duration DESC',
  random: 'RANDOM()',
};

export const MAX_RULES = 12;
export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 100;

/** Ошибка правил: сообщение показывается человеку, поэтому по-русски. */
export class RuleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function asNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(number)) {
    throw new RuleError('invalid_value', `Правило «${field}»: нужно число.`);
  }
  if (number < min || number > max) {
    throw new RuleError('invalid_value', `Правило «${field}»: значение вне допустимого диапазона.`);
  }
  return number;
}

/**
 * Приводит правила к каноническому виду и проверяет их.
 * Возвращает `{match, rules: [{field, op, value}], sort, limit}`.
 */
export function normalizeRules(input) {
  if (!input || typeof input !== 'object') {
    throw new RuleError('invalid_rules', 'Нужны правила плейлиста.');
  }
  const match = input.match === 'any' ? 'any' : 'all';
  const rawRules = Array.isArray(input.rules) ? input.rules : [];
  if (!rawRules.length) {
    throw new RuleError('invalid_rules', 'Нужно хотя бы одно правило.');
  }
  if (rawRules.length > MAX_RULES) {
    throw new RuleError('too_many_rules', `Не больше ${MAX_RULES} правил.`);
  }

  const rules = rawRules.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new RuleError('invalid_rule', `Правило №${index + 1}: ожидался объект.`);
    }
    const field = String(raw.field ?? '');
    const spec = FIELDS[field];
    if (!spec) {
      throw new RuleError('unknown_field', `Правило №${index + 1}: неизвестное поле «${field}».`);
    }
    const op = String(raw.op ?? '');
    if (!spec.ops.includes(op)) {
      throw new RuleError(
        'unknown_op',
        `Правило №${index + 1}: оператор «${op}» не подходит для поля «${field}».`
      );
    }

    if (spec.type === 'boolean') {
      return { field, op, value: parseBool(raw.value) };
    }
    if (spec.type === 'number') {
      const max = field === 'year' ? 9999 : 1e9;
      return { field, op, value: asNumber(raw.value, field, { min: 0, max }) };
    }
    // текст: `empty`/`any` значения не требуют
    if (op === 'empty' || op === 'any') return { field, op };
    const text = String(raw.value ?? '').trim();
    if (!text) {
      throw new RuleError('invalid_value', `Правило «${field}»: нужно значение.`);
    }
    return { field, op, value: text.slice(0, 200) };
  });

  const sort = rawSort(input.sort);
  // Ноль и отрицательные — «не задано»: `Number(-5) || DEFAULT` даёт -5, и
  // такой лимит молча превращался бы в один трек.
  const limitInput = Number(input.limit);
  const limit = Number.isFinite(limitInput) && limitInput > 0
    ? Math.min(Math.floor(limitInput), MAX_LIMIT)
    : DEFAULT_LIMIT;
  return { match, rules, sort, limit };
}

function rawSort(value) {
  const sort = String(value ?? 'recent');
  if (sort.startsWith('field:')) {
    const field = sort.slice('field:'.length);
    const spec = FIELDS[field];
    // сортировка по полю: только реальная колонка, иначе — по дате
    if (!spec || !['genre', 'artist', 'album', 'title', 'plays', 'duration'].includes(field)) {
      return 'recent';
    }
    return `field:${field}`;
  }
  return sort in SORTS ? sort : 'recent';
}

function parseBool(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  throw new RuleError('invalid_value', 'Правило «лайк»: нужно true или false.');
}

/**
 * Собирает `WHERE`-фрагмент. Возвращает `{sql, params}`.
 * Значения — только параметры; в текст SQL попадают исключительно `column`
 * из таблицы выше и строковые литералы операторов.
 */
export function buildWhere(normalized) {
  const parts = [];
  const params = [];
  let needsListens = false;

  for (const rule of normalized.rules) {
    const spec = FIELDS[rule.field];
    const column = spec.column;
    if (spec.joinListens) needsListens = true;

    switch (rule.op) {
      case 'is':
        if (spec.type === 'boolean') {
          parts.push(`t.liked = ?`);
          params.push(rule.value ? 1 : 0);
        } else {
          parts.push(`${column} = ? COLLATE NOCASE`);
          params.push(rule.value);
        }
        break;
      case 'contains':
        parts.push(`${column} LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLike(rule.value)}%`);
        break;
      case 'gte':
        parts.push(`${column} >= ?`);
        params.push(rule.value);
        break;
      case 'lte':
        parts.push(`${column} <= ?`);
        params.push(rule.value);
        break;
      case 'eq':
        parts.push(`${column} = ?`);
        params.push(rule.value);
        break;
      case 'empty':
        parts.push(`(${column} IS NULL OR trim(${column}) = '')`);
        break;
      case 'any':
        parts.push(`(${column} IS NOT NULL AND trim(${column}) <> '')`);
        break;
      default:
        throw new RuleError('unknown_op', `Оператор «${rule.op}» не поддержан.`);
    }
  }

  return { sql: parts.length ? parts.join(normalized.match === 'any' ? ' OR ' : ' AND ') : '1', params, needsListens };
}

/** `%` и `_` в пользовательском тексте — литералы, а не шаблон LIKE. */
export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** `FROM` для правил: JOIN на историю нужен только правилу «забытые». */
export function buildFrom(where) {
  return where.needsListens ? 'FROM tracks t LEFT JOIN listens l ON l.track_id = t.id' : 'FROM tracks t';
}

export function orderSql(sort) {
  if (sort.startsWith('field:')) {
    const column = FIELDS[sort.slice(6)]?.column ?? 't.created_at';
    return `${column} COLLATE NOCASE ASC, t.title COLLATE NOCASE ASC`;
  }
  return SORTS[sort] ?? SORTS.recent;
}

/** Готовый запрос «какие треки подходят»: `SELECT t.* <from> WHERE <sql> ORDER BY <order>`. */
export function buildSmartQuery(normalized) {
  const where = buildWhere(normalized);
  return {
    from: buildFrom(where),
    where: where.sql,
    params: where.params,
    order: orderSql(normalized.sort),
    limit: normalized.limit,
  };
}

/** Человеческие подписи правил — для интерфейса и для отладки в логах. */
const FIELD_LABELS = {
  genre: 'жанр',
  artist: 'исполнитель',
  album: 'альбом',
  title: 'название',
  liked: 'лайк',
  year: 'год добавления',
  plays: 'прослушивания',
  duration: 'длительность',
  addedDays: 'добавлен за последние дней',
  notPlayedDays: 'не слушал дней',
};

const OP_LABELS = {
  is: '=',
  contains: 'содержит',
  gte: '≥',
  lte: '≤',
  eq: '=',
  empty: 'пустой',
  any: 'заполнен',
};

export function describeRules(normalized) {
  const joiner = normalized.match === 'any' ? ' или ' : ' и ';
  return normalized.rules
    .map((rule) => {
      const field = FIELD_LABELS[rule.field] ?? rule.field;
      const op = OP_LABELS[rule.op] ?? rule.op;
      if (rule.op === 'empty' || rule.op === 'any') return `${field} ${op}`;
      if (rule.field === 'liked') return rule.value ? 'лайк' : 'без лайка';
      return `${field} ${op} ${rule.value}`;
    })
    .join(joiner);
}
