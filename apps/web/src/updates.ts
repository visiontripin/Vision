/**
 * Автообновление десктопа (I4): разбор манифеста и решение «пора предлагать».
 *
 * Почему логика отдельно от Tauri: сам updater живёт в Rust и сам проверяет
 * подпись, но **интерфейс** решает, что показать человеку. Ошибка здесь — это
 * либо «обновление есть, а мы молчим», либо «предлагаем то же самое каждый
 * запуск». Поэтому разбор версий и манифеста — чистые функции под тестами.
 *
 * Формат манифеста — Tauri updater 2 (`latest.json`, см. `docs/DESKTOP.md`).
 */

export type UpdatePlatform = {
  signature: string;
  url: string;
};

export type UpdateManifest = {
  version: string;
  pub_date?: string;
  notes?: string;
  platforms: Record<string, UpdatePlatform>;
};

export type UpdateCandidate = {
  version: string;
  notes: string | null;
  publishedAt: string | null;
  /** адрес и подпись именно для этой платформы; без них обновление не предлагаем */
  url: string;
  signature: string;
};

/** `0.3.0` → `[0, 3, 0]`. Суффиксы (`-beta`, `+build`) отбрасываются. */
export function parseVersion(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Сравнение версий: `1` — `next` новее, `0` — равны, `-1` — старее, `null` —
 * хотя бы одна версия не разобралась (тогда сравнивать нечего и предлагать
 * обновление нельзя).
 */
export function compareVersions(next: string, current: string): number | null {
  const a = parseVersion(next);
  const b = parseVersion(current);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

/** Ключ платформы в манифесте Tauri: `linux-x86_64`, `windows-x86_64`, `darwin-aarch64`. */
export function platformKey(os: string, arch: string): string | null {
  const normalizedOs = String(os || '').toLowerCase();
  const normalizedArch = String(arch || '').toLowerCase();

  const osPart = normalizedOs === 'win32' || normalizedOs === 'windows'
    ? 'windows'
    : normalizedOs === 'darwin' || normalizedOs === 'macos'
      ? 'darwin'
      : normalizedOs === 'linux'
        ? 'linux'
        : null;
  if (!osPart) return null;

  const archPart = ['x64', 'x86_64', 'amd64'].includes(normalizedArch)
    ? 'x86_64'
    : ['arm64', 'aarch64'].includes(normalizedArch)
      ? 'aarch64'
      : ['ia32', 'i686', 'x86'].includes(normalizedArch)
        ? 'i686'
        : normalizedArch === 'armv7l'
          ? 'armv7'
          : null;
  if (!archPart) return null;
  return `${osPart}-${archPart}`;
}

const isHttp = (value: unknown): value is string =>
  typeof value === 'string' && /^https?:\/\/\S+$/i.test(value);

/**
 * Манифест → кандидат на обновление, если он новее текущей версии и для этой
 * платформы есть подписанный артефакт. `null` означает «нечего предлагать»
 * и покрывает сразу все случаи: нет платформы, битый JSON, та же версия,
 * обновление «в прошлое».
 */
export function parseManifest(
  raw: unknown,
  { currentVersion, platform }: { currentVersion: string; platform: string | null }
): UpdateCandidate | null {
  if (!raw || typeof raw !== 'object' || !platform) return null;
  const manifest = raw as Partial<UpdateManifest>;
  if (typeof manifest.version !== 'string') return null;

  const order = compareVersions(manifest.version, currentVersion);
  if (order === null || order <= 0) return null;

  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== 'object') return null;
  const target = (platforms as Record<string, Partial<UpdatePlatform>>)[platform];
  if (!target || !isHttp(target.url) || typeof target.signature !== 'string' || !target.signature) {
    return null;
  }

  return {
    version: manifest.version,
    notes: typeof manifest.notes === 'string' && manifest.notes.trim() ? manifest.notes.trim() : null,
    publishedAt: typeof manifest.pub_date === 'string' ? manifest.pub_date : null,
    url: target.url,
    signature: target.signature,
  };
}

const SNOOZE_KEY = 'vision.update.snoozed';
const SNOOZE_MS = 24 * 3600_000;

/**
 * «Отложить» — это на сутки и до следующей версии: иначе плашка вернётся при
 * каждом запуске и её перестанут читать. Хранение — `localStorage`, потому что
 * это настройка интерфейса, а не данных библиотеки.
 */
export function snoozeUpdate(version: string, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(SNOOZE_KEY, JSON.stringify({ version, until: Date.now() + SNOOZE_MS }));
  } catch {
    /* приватный режим или переполнение — просто не запоминаем */
  }
}

export function isSnoozed(
  version: string,
  now = Date.now(),
  storage: Pick<Storage, 'getItem'> | null = safeStorage()
): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(SNOOZE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { version?: string; until?: number };
    // новая версия снимает «отложено»: про 0.4.0 человек ещё не отказывался
    if (parsed.version !== version) return false;
    return Number(parsed.until) > now;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Периодичность проверки: при запуске, затем раз в 6 часов (не чаще). */
export const UPDATE_INTERVAL_MS = 6 * 3600_000;

/** Заголовок плашки: одна строка, без «новых возможностей» ради слов. */
export function updateLabel(candidate: UpdateCandidate, currentVersion: string): string {
  const from = parseVersion(currentVersion)?.[0] !== undefined ? ` с ${currentVersion}` : '';
  return `Доступна версия ${candidate.version}${from}`;
}
