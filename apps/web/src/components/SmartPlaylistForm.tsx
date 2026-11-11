import { useMemo, useState } from 'react';
import type { SmartRule } from '@vision/shared';
import { Icon } from '../ui';
import {
  FIELDS, LIMITS, SORTS, fieldOf, summarize, validateDraft,
  type DraftRule, type SmartPlaylistDraft,
} from '../smart-form';

export type { SmartPlaylistDraft } from '../smart-form';

/**
 * Конструктор умного плейлиста (C7).
 *
 * Задача интерфейса — не «дать построить SQL», а помочь собрать понятную
 * подборку: поле выбирается из списка, операторы подставляются под тип поля,
 * а рядом с полями стоят единицы измерения («дней», «секунд»), потому что
 * «не слушал 30» без единицы читается как угодно.
 *
 * Ошибки проверяются и здесь (пустое значение, нет числа), и на сервере —
 * сервер всё равно обязан отказать, интерфейс лишь экономит круг.
 */

export function SmartPlaylistForm({
  initial,
  title = 'Новый умный плейлист',
  submitLabel = 'Создать',
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<SmartPlaylistDraft>;
  title?: string;
  submitLabel?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (draft: SmartPlaylistDraft) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<SmartPlaylistDraft>(() => ({
    name: initial?.name ?? '',
    match: initial?.match ?? 'all',
    sort: initial?.sort ?? 'recent',
    limit: initial?.limit ?? 40,
    rules: initial?.rules?.length
      ? initial.rules
      : [{ field: 'genre', op: 'is', value: '' }],
  }));
  const [localError, setLocalError] = useState<string | null>(null);

  const patchRule = (index: number, patch: Partial<DraftRule>) => {
    setDraft((prev) => ({
      ...prev,
      rules: prev.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    }));
  };

  const changeField = (index: number, field: SmartRule['field']) => {
    const spec = fieldOf(field);
    // при смене поля оператор и значение сбрасываются: «gte» для жанра — ошибка
    patchRule(index, { field, op: spec.ops[0].value, value: '' });
  };

  const addRule = () => {
    setDraft((prev) => ({
      ...prev,
      rules: [...prev.rules, { field: 'genre', op: 'is', value: '' }],
    }));
  };

  const removeRule = (index: number) => {
    setDraft((prev) => ({ ...prev, rules: prev.rules.filter((_, i) => i !== index) }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const problem = validateDraft(draft);
    setLocalError(problem);
    if (problem) return;
    if (!draft.name.trim()) {
      setLocalError('Нужно название плейлиста.');
      return;
    }
    onSubmit({ ...draft, name: draft.name.trim() });
  };

  const message = localError ?? error ?? null;
  const summary = useMemo(() => summarize(draft), [draft]);

  return (
    <form className="smart-form" onSubmit={submit}>
      <header className="smart-form__head">
        <h2>{title}</h2>
        <p>Состав пересчитывается сам: добавьте трек с нужным жанром — он попадёт в подборку.</p>
      </header>

      <label className="field">
        <span>Название</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
          placeholder="Например, «Тихий вечер»"
          maxLength={120}
        />
      </label>

      <div className="smart-form__match">
        <span>Трек подходит, если</span>
        <div className="segmented" role="group" aria-label="Как объединять правила">
          {(['all', 'any'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={draft.match === value ? 'is-active' : ''}
              onClick={() => setDraft((prev) => ({ ...prev, match: value }))}
            >
              {value === 'all' ? 'все правила' : 'любое правило'}
            </button>
          ))}
        </div>
      </div>

      <div className="smart-form__rules">
        {draft.rules.map((rule, index) => {
          const spec = fieldOf(rule.field);
          const needsValue = rule.op !== 'empty' && rule.op !== 'any';
          return (
            <div className="smart-rule" key={index}>
              <select
                value={rule.field}
                aria-label={`Поле правила ${index + 1}`}
                onChange={(event) => changeField(index, event.target.value as SmartRule['field'])}
              >
                {FIELDS.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                  </option>
                ))}
              </select>

              <select
                value={rule.op}
                aria-label={`Оператор правила ${index + 1}`}
                onChange={(event) => patchRule(index, { op: event.target.value as SmartRule['op'], value: '' })}
              >
                {spec.ops.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>

              {needsValue && spec.kind === 'bool' && (
                <select
                  value={rule.value || 'true'}
                  aria-label={`Значение правила ${index + 1}`}
                  onChange={(event) => patchRule(index, { value: event.target.value })}
                >
                  <option value="true">есть</option>
                  <option value="false">нет</option>
                </select>
              )}

              {needsValue && spec.kind === 'number' && (
                <span className="smart-rule__number">
                  <input
                    type="number"
                    min={0}
                    value={rule.value}
                    aria-label={`Значение правила ${index + 1}`}
                    placeholder={spec.valueLabel}
                    onChange={(event) => patchRule(index, { value: event.target.value })}
                  />
                  {spec.unit && <em>{spec.unit}</em>}
                </span>
              )}

              {needsValue && spec.kind === 'text' && (
                <input
                  value={rule.value}
                  aria-label={`Значение правила ${index + 1}`}
                  placeholder={spec.valueLabel}
                  onChange={(event) => patchRule(index, { value: event.target.value })}
                />
              )}

              <button
                type="button"
                className="iconbtn"
                aria-label={`Удалить правило ${index + 1}`}
                onClick={() => removeRule(index)}
                disabled={draft.rules.length === 1}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="smart-form__row">
        <button type="button" className="btn btn--ghost btn--sm" onClick={addRule}>
          <Icon name="plus" size={15} />
          Ещё правило
        </button>

        <label className="field field--inline">
          <span>Сортировка</span>
          <select
            value={draft.sort}
            onChange={(event) => setDraft((prev) => ({ ...prev, sort: event.target.value as SmartPlaylistDraft['sort'] }))}
          >
            {SORTS.map((sort) => (
              <option key={sort.value} value={sort.value}>
                {sort.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--inline">
          <span>Сколько треков</span>
          <select
            value={draft.limit}
            onChange={(event) => setDraft((prev) => ({ ...prev, limit: Number(event.target.value) }))}
          >
            {LIMITS.map((limit) => (
              <option key={limit} value={limit}>
                {limit}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="smart-form__summary">
        <Icon name="search" size={14} />
        {summary}
      </p>

      {message && (
        <p className="smart-form__error" role="alert">
          {message}
        </p>
      )}

      <div className="smart-form__actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Сохраняю…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Отмена
          </button>
        )}
      </div>
    </form>
  );
}
