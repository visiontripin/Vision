import type { Track } from '@vision/shared';

/**
 * Общая библиотека между устройствами (чистая логика, без сети и React Native).
 *
 * Задача владельца: загрузил пять песен на одном телефоне — на другом они
 * появились сами. Это реестр «у кого что есть», который устройства ведут общими
 * усилиями.
 *
 * Почему не «сервер на телефоне». Входящее соединение работает только когда оба
 * устройства в одной Wi-Fi и телефон не спит. Требование — **любое подключение к
 * сети**, значит и мобильный интернет, и разные сети, и NAT. Поэтому каждое
 * устройство делает **исходящий** запрос к общему реестру и забирает оттуда
 * метаданные. Реестр маленький: только названия, артисты и адреса.
 *
 * Здесь нет HTTP: модуль решает, что и когда отправлять/принимать. Сеть — в
 * `apps/mobile/src/sync.tsx`, и её можно заменить на любой транспорт.
 */

/** Что устройство объявляет о себе в реестре. */
export type DeviceInfo = {
  /** стабильный id устройства (генерируется один раз) */
  id: string;
  name: string;
  /** публичный адрес, по которому другие могут скачать файлы; null — не раздаём */
  baseUrl: string | null;
  at: number;
};

/** Запись трека в общей библиотеке. */
export type SharedTrack = {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  genre?: string | null;
  duration: number;
  mime: string;
  bytes: number;
  /** sha256 содержимого: по нему ищется копия, даже если id разошлись */
  checksum?: string | null;
  deviceId: string;
  deviceName: string;
  /** есть ли у владельца вход по HTTP: иначе трек виден, но не скачивается */
  downloadable: boolean;
  updatedAt: number;
};

export type Registry = {
  version: 1;
  devices: Record<string, DeviceInfo>;
  tracks: Record<string, SharedTrack>;
  /** id треков, файлы которых реестр уже принял: их не надо отправлять снова */
  published?: Record<string, true>;
};

export const EMPTY_REGISTRY: Registry = { version: 1, devices: {}, tracks: {} };

/** Через сколько устройство считается офлайн. */
export const DEVICE_TTL_MS = 15 * 60 * 1000;

/**
 * Сливает ответ реестра с локальной копией.
 *
 * Правило конфликта: **побеждает более свежая запись** (`updatedAt`). Так два
 * устройства, переименовавшие один трек, не «моргают» туда-сюда: последнее
 * изменение видно всем до следующего обновления.
 */
export function mergeRegistry(local: Registry, incoming: Registry | null | undefined): Registry {
  if (!incoming || typeof incoming !== 'object') return local;
  const published = { ...(local.published ?? {}), ...(incoming.published ?? {}) };
  const tracks = { ...local.tracks };
  for (const [id, track] of Object.entries(incoming.tracks ?? {})) {
    if (!track || !track.id) continue;
    const current = tracks[id];
    if (!current || (track.updatedAt ?? 0) >= (current.updatedAt ?? 0)) tracks[id] = track;
  }
  const devices = { ...local.devices };
  for (const [id, device] of Object.entries(incoming.devices ?? {})) {
    if (!device || !device.id) continue;
    const current = devices[id];
    if (!current || (device.at ?? 0) >= (current.at ?? 0)) devices[id] = device;
  }
  return { version: 1, tracks, devices, published };
}

/** Живые устройства: по ним видно, у кого сейчас есть музыка. */
export function activeDevices(registry: Registry, now = Date.now(), ttl = DEVICE_TTL_MS): DeviceInfo[] {
  return Object.values(registry.devices)
    .filter((device) => now - (device.at ?? 0) <= ttl)
    .sort((left, right) => (right.at ?? 0) - (left.at ?? 0));
}

/**
 * Треки для ленты: чужие сверху, потому что именно ради них лента и нужна.
 * Свои тоже показываются — но у них есть локальный файл, и это видно в интерфейсе.
 */
export function feedTracks(
  registry: Registry,
  selfId: string,
  options: { now?: number; ttl?: number } = {}
): (SharedTrack & { mine: boolean })[] {
  const now = options.now ?? Date.now();
  const ttl = options.ttl ?? DEVICE_TTL_MS;
  return Object.values(registry.tracks)
    .filter((track) => {
      if (track.deviceId === selfId) return true;
      const device = registry.devices[track.deviceId];
      // Чужой трек без живого устройства — мусор: файла всё равно нет
      return Boolean(device) && now - (device.at ?? 0) <= ttl;
    })
    .map((track) => ({ ...track, mine: track.deviceId === selfId }))
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

/** Метаданные трека для отправки в реестр — без полей, которые знает только владелец. */
export function toSharedTrack(
  track: Track,
  device: { id: string; name: string },
  bytes: number,
  downloadable: boolean,
  now = Date.now()
): SharedTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist ?? '',
    album: track.album ?? null,
    genre: track.genre ?? null,
    duration: Math.max(0, Math.round(track.duration || 0)),
    mime: track.mime || 'audio/mpeg',
    bytes: Math.max(0, Math.round(bytes || 0)),
    checksum: track.checksum ?? null,
    deviceId: device.id,
    deviceName: device.name,
    downloadable,
    updatedAt: now,
  };
}

/** Список «что отправить»: свои треки из локальной библиотеки. */
export function outgoing(registry: Registry, selfId: string, tracks: Track[], bytesOf: (id: string) => number, device: { id: string; name: string }, downloadable: boolean, now = Date.now()): SharedTrack[] {
  return tracks.map((track) => {
    const previous = registry.tracks[track.id];
    const fresh = !previous || previous.deviceId !== selfId;
    return toSharedTrack(
      track,
      device,
      previous && previous.deviceId === selfId ? previous.bytes : bytesOf(track.id),
      downloadable,
      // Не двигаем время зря: иначе каждая отправка перетирает правки других
      fresh ? now : previous.updatedAt
    );
  });
}

/**
 * Адрес файла в общей библиотеке.
 *
 * Файл отдаёт **реестр**, а не телефон: входящее соединение к мобильному
 * устройству работает только в одной Wi-Fi, а требование — любая сеть. Поэтому
 * каждая загрузка кладёт файл в реестр, и оттуда его скачивает любое устройство.
 *
 * `baseUrl` — адрес реестра (например `https://sync.example.com`). Нет адреса —
 * ссылки нет: трек останется видимым, но с пометкой «недоступен», а не с
 * кнопкой, которая молча не работает.
 */
export function downloadUrl(track: SharedTrack, baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  const base = String(baseUrl).replace(/\/+$/, '');
  return `${base}/api/library/${encodeURIComponent(track.id)}/file`;
}

/**
 * Слияние чужого трека в локальную библиотеку.
 *
 * Возвращает только то, чего у нас нет — по id **и** по контрольной сумме:
 * одинаковый файл, загруженный на двух телефонах, должен остаться одним треком.
 */
export function missingTracks(incoming: SharedTrack[], localIds: string[], localChecksums: string[]): SharedTrack[] {
  const ids = new Set(localIds);
  const sums = new Set(localChecksums.filter(Boolean));
  return incoming.filter((track) => !ids.has(track.id) && !(track.checksum && sums.has(track.checksum)));
}
