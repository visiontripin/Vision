/**
 * Логика конструктора умных плейлистов (C7) — отдельно от вёрстки.
 *
 * Здесь только чистые функции: словарь полей, перевод черновика формы в правила
 * контракта и обратная подпись по-русски. Так их можно тестировать без React и
 * без `import.meta.env`, а компонент остаётся про разметку.
 */
import type { SmartRule, SmartRules } from '@vision/shared';

export type FieldSpec = {
  key: SmartRule['field'];
  label: string;
  /** Какие операторы показывать и как они называются человеку. */
  ops: { value: SmartRule['op']; label: string }[];
  /** `text` рисует input, `number` — число с подсказкой единицы, `bool` — выбор. */
  kind: 'text' | 'number' | 'bool';
  unit?: string;
  valueLabel: string;
};

export const FIELDS: FieldSpec[] = [
  {
    key: 'genre',
    label: 'Жанр',
    kind: 'text',
    valueLabel: 'Название жанра',
    ops: [
      { value: 'is', label: 'равен' },
      { value: 'contains', label: 'содержит' },
      { value: 'empty', label: 'не указан' },
      { value: 'any', label: 'указан' },
    ],
  },
  {
    key: 'artist',
    label: 'Исполнитель',
    kind: 'text',
    valueLabel: 'Имя исполнителя',
    ops: [
      { value: 'is', label: 'равен' },
      { value: 'contains', label: 'содержит' },
      { value: 'empty', label: 'не указан' },
      { value: 'any', label: 'указан' },
    ],
  },
  {
    key: 'album',
    label: 'Альбом',
    kind: 'text',
    valueLabel: 'Название альбома',
    ops: [
      { value: 'is', label: 'равен' },
      { value: 'contains', label: 'содержит' },
      { value: 'empty', label: 'не указан' },
    ],
  },
  {
    key: 'liked',
    label: 'Лайк',
    kind: 'bool',
    valueLabel: 'Значение',
    ops: [{ value: 'is', label: 'равен' }],
  },
  {
    key: 'duration',
    label: 'Длительность',
    kind: 'number',
    unit: 'секунд',
    valueLabel: 'Длительность',
    ops: [
      { value: 'gte', label: 'не короче' },
      { value: 'lte', label: 'не длиннее' },
    ],
  },
  {
    key: 'plays',
    label: 'Прослушивания',
    kind: 'number',
    unit: 'раз',
    valueLabel: 'Прослушивания',
    ops: [
      { value: 'gte', label: 'не меньше' },
      { value: 'lte', label: 'не больше' },
    ],
  },
  {
    key: 'addedDays',
    label: 'Дата добавления',
    kind: 'number',
    unit: 'дней назад',
    valueLabel: 'Добавлен за последние',
    ops: [{ value: 'lte', label: 'не позже чем' }],
  },
  {
    key: 'notPlayedDays',
    label: 'Забытые треки',
    kind: 'number',
    unit: 'дней',
    valueLabel: 'Не слушал',
    ops: [{ value: 'gte', label: 'не меньше' }],
  },
];

export const SORTS: { value: NonNullable<SmartRules['sort']>; label: string }[] = [
  { value: 'recent', label: 'Сначала новые' },
  { value: 'oldest', label: 'Сначала старые' },
  { value: 'title', label: 'По названию' },
  { value: 'artist', label: 'По исполнителю' },
  { value: 'plays', label: 'По прослушиваниям' },
  { value: 'duration', label: 'По длительности' },
  { value: 'random', label: 'Вперемешку' },
];

export const LIMITS = [25, 40, 50, 100, 200];

export type DraftRule = { field: SmartRule['field']; op: SmartRule['op']; value: string };

/** Черновик формы целиком — то, что конструктор отдаёт наружу. */
export type SmartPlaylistDraft = {
  name: string;
  match: 'all' | 'any';
  rules: DraftRule[];
  sort: NonNullable<SmartRules['sort']>;
  limit: number;
};

export const fieldOf = (key: SmartRule['field']) => FIELDS.find((spec) => spec.key === key) ?? FIELDS[0];

/** Значения из формы → правила контракта. Пустые значения отбрасываются. */
export function toRules(draft: {
  match: 'all' | 'any';
  rules: DraftRule[];
  sort: NonNullable<SmartRules['sort']>;
  limit: number;
}): SmartRules {
  return {
    match: draft.match,
    sort: draft.sort,
    limit: draft.limit,
    rules: draft.rules.map((rule) => {
      const spec = fieldOf(rule.field);
      const base = { field: rule.field, op: rule.op } as SmartRule;
      if (rule.op === 'empty' || rule.op === 'any') return base;
      if (spec.kind === 'bool') return { ...base, value: rule.value === 'true' };
      if (spec.kind === 'number') return { ...base, value: Number(rule.value) };
      return { ...base, value: rule.value.trim() };
    }),
  };
}

/** Проверка «можно отправлять»: сервер откажет и сам, но круг по сети не нужен. */
export function validateDraft(draft: { rules: DraftRule[] }): string | null {
  if (!draft.rules.length) return 'Добавьте хотя бы одно правило.';
  for (const [index, rule] of draft.rules.entries()) {
    const spec = fieldOf(rule.field);
    if (rule.op === 'empty' || rule.op === 'any') continue;
    if (spec.kind === 'number') {
      if (!rule.value.trim()) return `Правило №${index + 1}: укажите число.`;
      if (!Number.isFinite(Number(rule.value)) || Number(rule.value) < 0) {
        return `Правило №${index + 1}: нужно неотрицательное число.`;
      }
      continue;
    }
    if (spec.kind === 'text' && !rule.value.trim()) {
      return `Правило №${index + 1}: укажите значение.`;
    }
  }
  return null;
}

/**
 * Черновик → читаемая строка для формы. Сервер отдаёт свой `summary` для
 * сохранённого плейлиста; это же подпись нужна живьём, пока правила меняются.
 */
export function summarize(draft: { match: 'all' | 'any'; rules: DraftRule[] }): string {
  const parts = draft.rules.map((rule) => {
    const spec = fieldOf(rule.field);
    const op = spec.ops.find((item) => item.value === rule.op)?.label ?? rule.op;
    if (rule.op === 'empty' || rule.op === 'any') return `${spec.label.toLowerCase()} ${op}`;
    if (spec.kind === 'bool') return rule.value === 'false' ? 'без лайка' : 'с лайком';
    const unit = spec.unit ? ` ${spec.unit}` : '';
    const value = rule.value.trim() || '…';
    return `${spec.label.toLowerCase()} ${op} ${value}${unit}`;
  });
  return parts.join(draft.match === 'all' ? ' и ' : ' или ') || 'правил пока нет';
}
