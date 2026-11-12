import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import { useLocalLibrary } from './local';
import { KEYS as AUTH_KEYS } from './config';
import {
  EMPTY_REGISTRY,
  activeDevices,
  downloadUrl,
  feedTracks,
  mergeRegistry,
  outgoing,
  type Registry,
  type SharedTrack,
} from './lib/sync';

/**
 * Синхронизация общей библиотеки через интернет.
 *
 * Правило, которое определило архитектуру: библиотека общая **при любом
 * подключении к сети**, а не только по Wi-Fi. Значит входящие соединения не
 * годятся — за NAT и в мобильной сети до телефона не достучаться. Поэтому:
 *
 * 1. каждое устройство раз в 20 секунд делает **исходящий** запрос к общему
 *    реестру (`SYNC_URL`) и присылает туда метаданные своей библиотеки;
 * 2. чужие треки попадают в ленту сразу, без скачивания;
 * 3. файл тянется по требованию — с того устройства, где он лежит, напрямую
 *    (`downloadUrl`), если оно доступно; иначе трек виден с пометкой «нет на связи».
 *
 * Пока `SYNC_URL` не настроен, приложение работает как локальный плеер и честно
 * пишет об этом в ленте. Свой реестр можно поднять по `docs/SYNC.md`.
 */

/** Какое устройство считается «на связи»: то же окно, что в ленте. */
const LIVE_MS = 15 * 60 * 1000;

/**
 * Токен владельца для реестра.
 *
 * Реестр — это ваша библиотека, а не публичный каталог: тот же токен, что даёт
 * доступ к серверу. Без него реестр ответит 401, и лента честно скажет, что
 * синхронизация не настроена.
 */
async function authHeaders(): Promise<Record<string, string>> {
  // Читаем каждый раз: токен появляется после подключения к серверу и меняется
  // при повторном входе, а кэш «навсегда» делал бы синхронизацию вечно 401.
  const token = await AsyncStorage.getItem(AUTH_KEYS.token).catch(() => null);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const KEYS = {
  device: 'vision.device',
  registry: 'vision.registry',
  syncUrl: 'vision.syncUrl',
} as const;

/** Как часто обновляем реестр. 20 с — компромисс между «сразу видно» и батареей. */
const POLL_MS = 20_000;

/** Адрес по умолчанию: можно задать при сборке (`EXPO_PUBLIC_SYNC_URL`). */
const DEFAULT_SYNC_URL = process.env.EXPO_PUBLIC_SYNC_URL ?? '';

export type SyncState = {
  online: boolean;
  syncing: boolean;
  statusText: string;
  deviceName: string;
  deviceId: string;
  syncUrl: string;
  feed: (SharedTrack & { mine: boolean })[];
  devices: { id: string; name: string; at: number }[];
  /** скачать чужой трек к себе и поставить в очередь */
  fetchTrack: (id: string) => Promise<void>;
  /** объяснить состояние трека: почему не играет/не скачивается */
  explain: (id: string) => void;
  refresh: () => Promise<void>;
  /** отправить файл в общий реестр (после импорта) */
  publish: (id: string) => Promise<void>;
  setSyncUrl: (url: string) => Promise<void>;
  setDeviceName: (name: string) => Promise<void>;
};

const SyncContext = createContext<SyncState | null>(null);

type DeviceRecord = { id: string; name: string; at: number };

/** Имя устройства по умолчанию: различать свои телефоны в ленте. */
function defaultDeviceName(): string {
  return `Телефон ${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const local = useLocalLibrary();
  const [registry, setRegistry] = useState<Registry>(EMPTY_REGISTRY);
  const [device, setDevice] = useState<DeviceRecord>({ id: '', name: '', at: 0 });
  const [syncUrl, setSyncUrlState] = useState(DEFAULT_SYNC_URL);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  /** id, файлы которых уже отправлены в реестр на этом запуске */
  const publishedRef = useRef<Set<string>>(new Set());

  const registryRef = useRef(registry);
  registryRef.current = registry;
  const deviceRef = useRef(device);
  deviceRef.current = device;
  const urlRef = useRef(syncUrl);
  urlRef.current = syncUrl;

  /* ---- кто мы и куда ходим ---- */
  useEffect(() => {
    (async () => {
      const [rawDevice, rawRegistry, storedUrl] = await Promise.all([
        AsyncStorage.getItem(KEYS.device).catch(() => null),
        AsyncStorage.getItem(KEYS.registry).catch(() => null),
        AsyncStorage.getItem(KEYS.syncUrl).catch(() => null),
      ]);

      let record: DeviceRecord | null = null;
      try {
        record = rawDevice ? (JSON.parse(rawDevice) as DeviceRecord) : null;
      } catch {
        record = null;
      }
      const fresh: DeviceRecord =
        record?.id && record.name
          ? { id: record.id, name: record.name, at: Number(record.at) || Date.now() }
          : {
              id: `dev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: defaultDeviceName(),
              at: Date.now(),
            };
      if (fresh.id !== record?.id || fresh.name !== record?.name) {
        await AsyncStorage.setItem(KEYS.device, JSON.stringify(fresh)).catch(() => {});
      }
      setDevice(fresh);

      try {
        const stored = rawRegistry ? (JSON.parse(rawRegistry) as Registry) : null;
        // Кэш реестра: без сети лента показывает последнее известное состояние,
        // а не пустоту — «вчера работало» лучше, чем «ничего нет».
        if (stored?.tracks) setRegistry(mergeRegistry(EMPTY_REGISTRY, stored));
      } catch {
        /* битый кэш — начинаем с чистого */
      }

      if (storedUrl) setSyncUrlState(storedUrl);
    })();
  }, []);

  const persistRegistry = useCallback(async (next: Registry) => {
    setRegistry(next);
    registryRef.current = next;
    await AsyncStorage.setItem(KEYS.registry, JSON.stringify(next)).catch(() => {});
  }, []);

  /**
   * Загрузить файл в общий реестр.
   *
   * Без этого «общая библиотека при любом подключении» невозможна: телефон под
   * NAT не принимает входящие, поэтому файл должен оказаться на устройстве,
   * которое принимает. Метаданные уходят в реестр сразу, файл — здесь.
   */
  const publish = useCallback(
    async (id: string) => {
      const who = deviceRef.current;
      const target = urlRef.current;
      if (!target || !who.id) return;
      const uri = local.uriOf(id);
      if (!uri) return;
      try {
        const body = new FormData();
        body.append('file', { uri, name: `${id}.mp3`, type: 'audio/mpeg' } as unknown as Blob);
        body.append('deviceId', who.id);
        body.append('deviceName', who.name);
        const response = await fetch(`${target.replace(/\/+$/, '')}/api/library/${encodeURIComponent(id)}/file`, {
          method: 'PUT',
          headers: await authHeaders(),
          body,
        });
        if (!response.ok) throw new Error(`Реестр ответил ${response.status}`);
      } catch (cause) {
        // Файл не ушёл — трек всё равно виден другим, они скачают позже.
        setError(cause instanceof Error ? cause.message : 'Файл не загрузился в реестр');
      }
    },
    [local]
  );

  /* ---- один цикл обмена ---- */
  const cycle = useCallback(async () => {
    const who = deviceRef.current;
    const target = urlRef.current;
    if (!who.id) return;

    // Что мы отдаём: свои треки. Файлы не отправляем — только метаданные.
    const payload = {
      device: { id: who.id, name: who.name, baseUrl: null, at: Date.now() },
      tracks: outgoing(
        registryRef.current,
        who.id,
        local.tracks,
        (id) => local.bytesOf(id),
        { id: who.id, name: who.name },
        false
      ),
    };

    if (!target) {
      // Без реестра живём локально: свои треки видны, чужие — нет.
      setError('Синхронизация не настроена');
      return;
    }

    setSyncing(true);
    try {
      const response = await fetch(`${target.replace(/\/+$/, '')}/api/library`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Реестр ответил ${response.status}`);
      const incoming = (await response.json()) as Registry;
      await persistRegistry(mergeRegistry(registryRef.current, incoming));
      setOnline(true);
      setError(null);

      // Догружаем файлы, которых ещё нет в реестре (по одному за цикл, чтобы не
      // забивать канал, если библиотека большая).
      const pending = local.tracks.find(
        (track) => !publishedRef.current.has(track.id) && local.uriOf(track.id) && !incoming.published?.[track.id]
      );
      if (pending) {
        publishedRef.current.add(pending.id);
        void publish(pending.id);
      }
    } catch (cause) {
      setOnline(false);
      setError(cause instanceof Error ? cause.message : 'Нет связи с реестром');
    } finally {
      setSyncing(false);
    }
  }, [local, persistRegistry, publish]);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await cycle();
    } finally {
      busy.current = false;
    }
  }, [cycle]);

  /* ---- опрос + реакция на изменения библиотеки ---- */
  useEffect(() => {
    if (!device.id) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [device.id, refresh, syncUrl]);

  // Загрузили трек — покажем другим сразу, не ждём таймера.
  useEffect(() => {
    if (!device.id || !local.tracks.length) return;
    void refresh();
  }, [device.id, local.tracks.length, refresh]);

  /* ---- скачивание чужого трека ---- */
  const fetchTrack = useCallback(
    async (id: string) => {
      const track = registryRef.current.tracks[id];
      if (!track) return;
      if (track.deviceId === deviceRef.current.id) return;

      const source = downloadUrl(track, urlRef.current);
      if (!source) {
        Alert.alert(
          'Недоступен для скачивания',
          `Трек лежит на устройстве «${track.deviceName}», но оно сейчас не раздаёт файлы. ` +
            'Откройте приложение на том телефоне и оставьте его в сети — трек появится здесь.'
        );
        return;
      }

      setSyncing(true);
      try {
        // Сохраняем к себе: дальше это обычный локальный трек, он играет без сети.
        await local.addFromLink({ url: source, title: `${track.artist} - ${track.title}`.trim(), id: track.id });
        await refresh();
      } catch (cause) {
        Alert.alert('Не удалось скачать', cause instanceof Error ? cause.message : 'Устройство не ответило');
      } finally {
        setSyncing(false);
      }
    },
    [local, refresh]
  );

  const explain = useCallback(
    (id: string) => {
      const track = registryRef.current.tracks[id];
      if (!track) return;
      const mine = track.deviceId === deviceRef.current.id;
      const deviceInfo = registryRef.current.devices[track.deviceId];
      const live = deviceInfo ? Date.now() - deviceInfo.at < LIVE_MS : false;
      const buttons = [
        { text: 'Закрыть', style: 'cancel' as const },
        ...(mine
          ? [
              {
                text: 'Убрать с этого телефона',
                style: 'destructive' as const,
                onPress: () => void local.removeTrack(id),
              },
            ]
          : live
            ? [{ text: 'Скачать к себе', onPress: () => void fetchTrack(id) }]
            : []),
      ];
      Alert.alert(
        track.title,
        [
          `${track.artist || 'Без исполнителя'} · ${Math.round(track.duration / 60)}:${String(
            Math.round(track.duration % 60)
          ).padStart(2, '0')}`,
          mine ? 'Лежит на этом телефоне' : `Лежит на «${track.deviceName}»`,
          live ? 'Устройство на связи' : 'Устройство не в сети — скачать сейчас нельзя',
        ].join('\n'),
        buttons
      );
    },
    [fetchTrack, local]
  );

  const setSyncUrl = useCallback(async (url: string) => {
    const value = String(url ?? '').trim().replace(/\/+$/, '');
    setSyncUrlState(value);
    await AsyncStorage.setItem(KEYS.syncUrl, value).catch(() => {});
    setError(null);
  }, []);

  const setDeviceName = useCallback(
    async (name: string) => {
      const next = { ...deviceRef.current, name: String(name ?? '').trim() || defaultDeviceName(), at: Date.now() };
      setDevice(next);
      await AsyncStorage.setItem(KEYS.device, JSON.stringify(next)).catch(() => {});
    },
    []
  );

  const value = useMemo<SyncState>(() => {
    const feed = feedTracks(registry, device.id);
    const devices = activeDevices(registry).filter((item) => item.id !== device.id);
    const statusText = !syncUrl
      ? 'Синхронизация не настроена — музыка только на этом телефоне'
      : !online
        ? error ?? 'Нет связи — показываем последнее известное'
        : devices.length
          ? `${devices.length} ${devices.length === 1 ? 'устройство' : 'устройства'} на связи`
          : 'Ждём другие устройства';
    return {
      online,
      syncing,
      statusText,
      deviceName: device.name,
      deviceId: device.id,
      syncUrl,
      feed,
      devices,
      fetchTrack,
      explain,
      refresh,
      publish,
      setSyncUrl,
      setDeviceName,
    };
  }, [registry, device, syncUrl, online, syncing, error, fetchTrack, explain, refresh, publish, setSyncUrl, setDeviceName]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncState {
  const value = useContext(SyncContext);
  if (!value) throw new Error('useSync вне SyncProvider');
  return value;
}
