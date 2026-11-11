/**
 * Мелочи, которые легко ошибить и дешево покрыть тестами: форматирование
 * размеров/времени и «что не так с сервером», разложенное на понятные фразы.
 *
 * Файл чистый (без React и DOM), поэтому проверяется `node --test` в общем наборе.
 */

/** `1.4 ГБ`, `980 КБ` — так, как это читает человек, а не байты. */
export function humanBytes(bytes: number | null | undefined): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  // 1024 → «1 КБ»; десятые появляются только когда они что-то значат
  const digits = unit === 0 || size >= 100 ? 0 : Number.isInteger(size) ? 0 : size >= 10 ? 1 : 2;
  // без хвостовых нулей: «1,5 КБ», а не «1,50 КБ»
  const fixed = size.toFixed(digits);
  const text = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return `${text.replace('.', ',')} ${units[unit]}`;
}

/** Свободное место: предупреждаем заранее, а не когда диск кончился. */
export function diskState(freeMb: number | null | undefined): {
  level: 'ok' | 'low' | 'critical' | 'unknown';
  text: string;
} {
  if (freeMb === null || freeMb === undefined || !Number.isFinite(Number(freeMb))) {
    return { level: 'unknown', text: 'Свободное место неизвестно' };
  }
  const mb = Number(freeMb);
  if (mb < 500) return { level: 'critical', text: `Почти нет места: ${humanBytes(mb * 1024 * 1024)}` };
  if (mb < 5000) return { level: 'low', text: `Мало места: ${humanBytes(mb * 1024 * 1024)}` };
  return { level: 'ok', text: `Свободно ${humanBytes(mb * 1024 * 1024)}` };
}

/** `5 мин назад`, `2 дн назад` — для «последнего открытия» ссылки. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'ещё не открывали';
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return 'ещё не открывали';
  const diff = now - at;
  if (diff < 45_000) return 'только что';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

/** Срок жизни ссылки словами; `null` — бессрочно. */
export function expiry(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'бессрочная';
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return 'бессрочная';
  if (at <= now) return 'истекла';
  const hours = Math.round((at - now) / 3_600_000);
  if (hours < 1) return 'меньше часа';
  if (hours < 48) return `ещё ${hours} ч`;
  return `ещё ${Math.round(hours / 24)} дн`;
}

export type CheckLevel = 'ok' | 'warn' | 'fail';

export type ServerCheck = { level: CheckLevel; title: string; detail: string };

/**
 * Диагностика в панели: те же проверки, что делает RUNBOOK, но словами для
 * человека, который не читает логи. Порядок — от «сервер не работает» к мелочам.
 */
export function diagnose(health: {
  ok?: boolean;
  version?: string;
  diskFreeMb?: number | null;
  migrations?: { applied: string[]; pending: number };
  ffmpeg?: { available: boolean; version: string | null; path?: string | null };
  storage?: { mode: string; seedEnabled: boolean; deviceId: string; publicUrl: string | null };
  tracker?: { blobs: number; seeds: number; noSource: number };
} | null): ServerCheck[] {
  if (!health) {
    return [
      {
        level: 'fail',
        title: 'Сервер не отвечает',
        detail: 'Проверьте адрес, порт 4000 и что телефон/ПК с сервером в той же сети.',
      },
    ];
  }

  const checks: ServerCheck[] = [];

  checks.push(
    health.ok === false
      ? { level: 'fail', title: 'Сервер сообщает об ошибке', detail: 'GET /api/health вернул ok=false.' }
      : { level: 'ok', title: 'Сервер работает', detail: `Версия ${health.version ?? '?'}` }
  );

  const disk = diskState(health.diskFreeMb);
  checks.push({
    level: disk.level === 'critical' ? 'fail' : disk.level === 'low' ? 'warn' : 'ok',
    title: 'Диск',
    detail: disk.text,
  });

  const pending = health.migrations?.pending ?? 0;
  checks.push(
    pending > 0
      ? {
          level: 'warn',
          title: 'Миграции не применены',
          detail: `Ожидают ${pending}. Перезапустите сервер — они применятся сами.`,
        }
      : { level: 'ok', title: 'База обновлена', detail: `Схема: ${health.migrations?.applied.length ?? 0} миграций` }
  );

  if (health.ffmpeg) {
    checks.push(
      health.ffmpeg.available
        ? {
            level: 'ok',
            title: 'ffmpeg найден',
            detail: `${health.ffmpeg.version ?? 'версия неизвестна'} — будет opus/aac и пики при загрузке.`,
          }
        : {
            level: 'warn',
            title: 'ffmpeg не найден',
            detail: 'Загрузка работает, но без транскодинга и авто-волны. На Android это нормально.',
          }
    );
  }

  if (health.tracker) {
    const { blobs, seeds, noSource } = health.tracker;
    checks.push(
      noSource > 0
        ? {
            level: 'warn',
            title: 'Есть файлы без источника',
            detail: `${noSource} из ${blobs} файлов сейчас не раздаёт ни одно устройство.`,
          }
        : {
            level: 'ok',
            title: 'Файлы раздаются',
            detail: `${blobs} файлов, ${seeds} сидов в сети.`,
          }
    );
  }

  if (health.storage && !health.storage.publicUrl) {
    checks.push({
      level: 'warn',
      title: 'PUBLIC_URL не задан',
      detail: 'Ссылки для друзей будут с внутренним адресом. Укажите внешний адрес в настройках.',
    });
  }

  return checks;
}

/** «Готово к работе» — ни одной красной проверки. */
export function isReady(checks: ServerCheck[]): boolean {
  return checks.every((check) => check.level !== 'fail');
}

/**
 * Как открыть панель с телефона: адрес сервера + `/admin`. Если сервер сам отдал
 * панель (мы на том же origin), подсказка не нужна.
 */
export function adminUrl(base: string): string {
  return base ? `${base}/admin` : '/admin';
}

/**
 * Время в журнале действий (G10): «сегодня 14:03», «вчера 09:12», дальше — дата.
 * Панель смотрят с телефона, поэтому абсолютный ISO-штамп бесполезен: нужен
 * ответ на вопрос «давно ли это было».
 */
export function auditClock(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const time = date.getTime();
  if (!Number.isFinite(time)) return '—';

  const at = new Date(time);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;

  if (time >= startOfToday.getTime()) return `сегодня ${hh}:${mm}`;
  if (time >= startOfToday.getTime() - dayMs) return `вчера ${hh}:${mm}`;
  if (time >= startOfToday.getTime() - dayMs * 6) {
    return `${at.toLocaleDateString('ru-RU', { weekday: 'short' })} ${hh}:${mm}`;
  }
  return at.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
