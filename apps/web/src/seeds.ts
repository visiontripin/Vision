import type { Track } from '@vision/shared';
import { api, IS_LOCAL_MODE } from './api';

/**
 * Участие браузера в реестре реплик.
 *
 * Браузер не может отдавать файл по HTTP (у вкладки нет входящего сокета), поэтому
 * он регистрируется как «реплика»: в реестре видно, что копия существует, но
 * скачать с него нельзя — только с origin/Termux/десктопа. Это честно и не
 * обещает вечного торрента: см. docs/DISTRIBUTED.md.
 *
 * Реестр нужен, чтобы:
 *  - библиотека показывала «есть у N устройств» и «нет источника»;
 *  - после переустановки приложения копии оставались видимыми;
 *  - мобильное приложение могло показать, где лежит файл.
 */

const DEVICE_KEY = 'vision.deviceId';

/** Постоянный идентификатор устройства: переживает перезагрузку вкладки. */
export function deviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    if (saved) return saved;
    const id = `browser-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return 'browser-anon';
  }
}

/** Объявить офлайн-копию (после скачивания). Ошибки реестра не ломают кэш. */
export async function announceReplica(track: Track): Promise<void> {
  const hash = track.checksum;
  if (IS_LOCAL_MODE || !hash) return;
  try {
    await api.announceSeed({ hash, deviceId: deviceId(), kind: 'browser' });
  } catch {
    /* трекер недоступен — копия всё равно работает локально */
  }
}

/** Убрать копию из реестра (удалили офлайн-файл). */
export async function withdrawReplica(track: Track): Promise<void> {
  const hash = track.checksum;
  if (IS_LOCAL_MODE || !hash) return;
  try {
    await api.withdrawSeed(hash, deviceId());
  } catch {
    /* истёк TTL или трекер недоступен */
  }
}

/**
 * Повторно объявить все имеющиеся офлайн-копии: записи в реестре стареют, а
 * браузер не может слать heartbeat из закрытой вкладки.
 */
export async function syncReplicas(tracks: Track[], isCached: (id: string) => boolean): Promise<number> {
  if (IS_LOCAL_MODE) return 0;
  const withCopies = tracks.filter((track) => track.checksum && isCached(track.id));
  for (const track of withCopies) await announceReplica(track);
  return withCopies.length;
}

/** Подпись под «нет источника»: что именно случилось. */
export function sourceLabel(track: Track): string | null {
  const sources = track.sources;
  if (!sources) return null;
  if (track.available === false) return 'нет источника';
  if (sources.servable === 0 && sources.replicas > 0) return 'только на устройствах';
  return null;
}
