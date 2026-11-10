import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Подписанные ссылки на обложки. Они короткоживущие, поэтому запрашиваем пачками
 * по мере появления треков в списке (максимум 200 id за запрос — лимит API).
 */
export function useCovers(ids: string[]): Record<string, string> {
  const [covers, setCovers] = useState<Record<string, string>>({});
  const key = Array.from(new Set(ids.filter(Boolean))).slice(0, 200).join(',');

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    api
      .media(key.split(','))
      .then((payload) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const [id, item] of Object.entries(payload.items)) {
          if (item.cover) next[id] = item.cover;
        }
        setCovers((prev) => ({ ...prev, ...next }));
      })
      .catch(() => {
        /* обложки не критичны: останется буква */
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return covers;
}
