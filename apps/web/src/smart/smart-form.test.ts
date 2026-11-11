import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, toRules, validateDraft } from '../smart-form';

/**
 * Конструктор умного плейлиста (C7): черновик формы → правила контракта.
 *
 * Здесь проверяется то, что нельзя увидеть глазами в браузере: числа
 * уходят числами (а не строками), «пустой жанр» не требует значения, а
 * опечатка в правиле ловится до запроса на сервер.
 */

const draft = (rules: { field: string; op: string; value: string }[], patch = {}) => ({
  match: 'all' as const,
  sort: 'recent' as const,
  limit: 40,
  rules: rules as never,
  ...patch,
});

test('черновик → правила: типы полей соблюдаются', () => {
  const rules = toRules(
    draft([
      { field: 'genre', op: 'is', value: '  Ambient  ' },
      { field: 'duration', op: 'gte', value: '300' },
      { field: 'liked', op: 'is', value: 'false' },
    ])
  );
  assert.deepEqual(rules.rules[0], { field: 'genre', op: 'is', value: 'Ambient' }, 'пробелы срезаны');
  assert.equal(rules.rules[1].value, 300, 'число, а не строка');
  assert.equal(rules.rules[2].value, false, 'булево, а не строка');
  assert.equal(rules.limit, 40);
  assert.equal(rules.sort, 'recent');
});

test('черновик → правила: правила без значения не тащат пустышку', () => {
  const rules = toRules(
    draft([
      { field: 'genre', op: 'empty', value: '' },
      { field: 'album', op: 'any', value: 'что-то' },
    ])
  );
  assert.deepEqual(rules.rules[0], { field: 'genre', op: 'empty' });
  assert.deepEqual(rules.rules[1], { field: 'album', op: 'any' }, 'лишнее значение отброшено');
});

test('проверка до запроса: пустые и кривые значения ловятся', () => {
  assert.equal(validateDraft(draft([{ field: 'genre', op: 'is', value: 'Ambient' }])), null);
  assert.equal(validateDraft(draft([{ field: 'genre', op: 'empty', value: '' }])), null);
  assert.match(validateDraft(draft([]))!, /хотя бы одно правило/);
  assert.match(validateDraft(draft([{ field: 'genre', op: 'is', value: '   ' }]))!, /укажите значение/);
  assert.match(validateDraft(draft([{ field: 'duration', op: 'gte', value: '' }]))!, /укажите число/);
  assert.match(validateDraft(draft([{ field: 'plays', op: 'gte', value: '-3' }]))!, /неотрицательное/);
  assert.match(validateDraft(draft([{ field: 'plays', op: 'gte', value: 'много' }]))!, /неотрицательное/);
});

test('подпись правил читается человеком и знает про единицы', () => {
  assert.equal(
    summarize(draft([{ field: 'genre', op: 'is', value: 'Ambient' }])),
    'жанр равен Ambient'
  );
  assert.equal(
    summarize(draft([{ field: 'notPlayedDays', op: 'gte', value: '30' }])),
    'забытые треки не меньше 30 дней'
  );
  assert.equal(
    summarize(draft([{ field: 'liked', op: 'is', value: 'false' }])),
    'без лайка'
  );
  assert.equal(
    summarize(
      draft(
        [
          { field: 'genre', op: 'is', value: 'Ambient' },
          { field: 'duration', op: 'gte', value: '300' },
        ],
        { match: 'any' as const }
      )
    ),
    'жанр равен Ambient или длительность не короче 300 секунд'
  );
  assert.equal(summarize(draft([])), 'правил пока нет');
});
