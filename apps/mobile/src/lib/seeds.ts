import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Track } from '@vision/shared';
import { api } from '../api';

/**
 * Участие телефона в реестре реплик.
 *
 * Скачанный трек лежит в приватном каталоге приложения, отдать его по HTTP
 * телефон не может (нет локального сервера, iOS/Android убьют фоновый процесс),
 * поэтому в реестр уходит «у меня есть копия» — `kind: 'mobile'`. Это позволяет
 * библиотеке показать «есть у N устройств» и не терять копию при переустановке.
 *
 * Все вызовы — best-effort: нет сети или трекер выключен — скачивание работает.
 */

const DEVICE_KEY = 'vision.deviceId';
let cached: string | null = null;

async function deviceId(): Promise<string> {
  if (cached) return cached;
  try {
    const saved = await AsyncStorage.getItem(DEVICE_KEY);
    if (saved) {
      cached = saved;
      return saved;
    }
    const id = `mobile-${Math.random().toString(36).slice(2, 10)}`;
    await AsyncStorage.setItem(DEVICE_KEY, id);
    cached = id;
    return id;
  } catch {
    cached = 'mobile-anon';
    return cached;
  }
}

/** Объявить скачанную копию в трекере. */
export async function announceReplica(track: Track): Promise<void> {
  if (!track.checksum) return;
  try {
    await api.announceSeed({ hash: track.checksum, deviceId: await deviceId(), kind: 'mobile' });
  } catch {
    /* трекер недоступен — копия всё равно играет */
  }
}

/** Убрать копию из трекера (файл удалён из приложения). */
export async function withdrawReplica(hash?: string | null): Promise<void> {
  if (!hash) return;
  try {
    await api.withdrawSeed(hash, await deviceId());
  } catch {
    /* истёк TTL или нет сети */
  }
}
