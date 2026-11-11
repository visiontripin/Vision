import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { uploadFileFromDevice } from '../api';
import {
  MAX_BATCH, buildUploadPlan, fileNameOf, guessMeta, mimeForFile, parseUploadResponse,
  progressLabel, validatePicked,
} from '../lib/upload';
import { colors, radius } from '../theme';

/**
 * Загрузка треков с телефона (H4).
 *
 * Сценарий один: «записал — залил». Поэтому экран не спрашивает альбом и год, а
 * показывает то, что уже знает: имя файла (из него — артист и название) и
 * очередь. Теги из самого файла прочитает сервер при загрузке и заменит
 * догадку — в этом и смысл: телефон не должен уметь разбирать ID3.
 *
 * Файл не читается в память: он уходит с диска через FormData, поэтому 300-МБ
 * запись не превращается в OOM. Очередь последовательная — десять параллельных
 * загрузок на мобильной сети это десять обрывов.
 */

type QueueItem = {
  key: string;
  uri: string;
  name: string;
  mime: string;
  size: number | null;
  /** Пустая строка = «взять из имени файла или тега» */
  title: string;
  artist: string;
  genre: string;
  status: 'pending' | 'uploading' | 'done' | 'duplicate' | 'failed';
  progress: number;
  message?: string;
};

const MAX_FILES_PER_PICK = MAX_BATCH;

export function UploadScreen({ visible, onClose, onUploaded }: {
  visible: boolean;
  onClose: () => void;
  onUploaded: () => Promise<void> | void;
}) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = useCallback((key: string, change: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  const pick = useCallback(async () => {
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        // Не `type: 'audio/*'`: часть файловых менеджеров отдаёт m4a как
        // application/octet-stream, и такой файл просто не показывается в выборе.
        type: ['audio/*', 'application/octet-stream'],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;

      const picked = result.assets.slice(0, MAX_FILES_PER_PICK);
      if (result.assets.length > MAX_FILES_PER_PICK) {
        setError(`Выбрано ${result.assets.length} файлов — добавлены первые ${MAX_FILES_PER_PICK}.`);
      }

      const next: QueueItem[] = [];
      for (const asset of picked) {
        const candidate = { uri: asset.uri, name: asset.name, mimeType: asset.mimeType, size: asset.size ?? null };
        const verdict = validatePicked(candidate);
        if (!verdict.ok) {
          // не добавляем в очередь то, что сервер всё равно отвергнет: пусть
          // человек видит причину сразу, а не после загрузки 200 МБ
          next.push({
            key: `${asset.uri}-${Date.now()}-${next.length}`,
            uri: asset.uri,
            name: asset.name,
            mime: mimeForFile(candidate),
            size: asset.size ?? null,
            title: '',
            artist: '',
            genre: '',
            status: 'failed',
            progress: 0,
            message: verdict.message,
          });
          continue;
        }
        const guessed = guessMeta(asset.name);
        next.push({
          key: `${asset.uri}-${Date.now()}-${next.length}`,
          uri: asset.uri,
          name: asset.name,
          mime: mimeForFile(candidate),
          size: asset.size ?? null,
          title: guessed.title === 'Без названия' ? '' : guessed.title,
          artist: guessed.artist ?? '',
          genre: '',
          status: 'pending',
          progress: 0,
        });
      }
      setQueue((prev) => [...prev, ...next].slice(0, MAX_FILES_PER_PICK * 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось открыть выбор файлов');
    }
  }, []);

  const pendingCount = useMemo(() => queue.filter((item) => item.status === 'pending').length, [queue]);

  const start = useCallback(async () => {
    const targets = queue.filter((item) => item.status === 'pending');
    if (!targets.length) return;
    setBusy(true);
    setError(null);

    let uploaded = 0;
    for (const item of targets) {
      patch(item.key, { status: 'uploading', progress: 0, message: undefined });
      try {
        const plan = buildUploadPlan(
          { uri: item.uri, name: item.name, mimeType: item.mime, size: item.size },
          { title: item.title, artist: item.artist, genre: item.genre }
        );
        const result = await uploadFileFromDevice(
          item.uri,
          { title: plan.title, artist: item.artist, genre: item.genre },
          { mime: plan.mime, onProgress: (percent) => patch(item.key, { progress: percent }) }
        );
        const outcome = parseUploadResponse(result.status, result.payload);
        if (outcome.kind === 'uploaded') {
          uploaded += 1;
          patch(item.key, { status: 'done', progress: 100, title: outcome.title });
        } else if (outcome.kind === 'duplicate') {
          patch(item.key, { status: 'duplicate', progress: 100, message: `Уже в библиотеке: ${outcome.title}` });
        } else {
          patch(item.key, { status: 'failed', message: outcome.message });
        }
      } catch (cause) {
        patch(item.key, {
          status: 'failed',
          message: cause instanceof Error ? cause.message : 'Не удалось отправить файл',
        });
      }
    }

    setBusy(false);
    if (uploaded > 0) await onUploaded();
  }, [queue, patch, onUploaded]);

  const doneCount = queue.filter((item) => item.status === 'done' || item.status === 'duplicate').length;
  const failedCount = queue.filter((item) => item.status === 'failed').length;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Загрузить с телефона</Text>
            <Text style={styles.subtitle}>
              {queue.length
                ? `${progressLabel(doneCount, queue.length)} · ошибок ${failedCount}`
                : 'Файл не читается в память: уходит прямо с диска'}
            </Text>
          </View>
          <Pressable onPress={onClose} style={styles.close} accessibilityLabel="Закрыть">
            <Text style={styles.closeText}>Закрыть</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          <View style={styles.actions}>
            <Pressable style={styles.pickButton} onPress={() => void pick()} disabled={busy}>
              <Text style={styles.pickButtonText}>Выбрать файлы</Text>
            </Pressable>
            <Pressable
              style={[styles.uploadButton, (!pendingCount || busy) && styles.buttonDisabled]}
              onPress={() => void start()}
              disabled={!pendingCount || busy}
            >
              <Text style={styles.uploadButtonText}>
                {busy ? 'Отправляю…' : pendingCount ? `Загрузить ${pendingCount}` : 'Загрузить'}
              </Text>
            </Pressable>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          {!queue.length && (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Пока ничего не выбрано</Text>
              <Text style={styles.emptyText}>
                Диктофон, скачанный файл, музыка из мессенджера — всё, что телефон умеет
                открыть как аудио. Название и исполнитель подставятся из имени файла, а теги
                из самого файла сервер прочитает сам.
              </Text>
            </View>
          )}

          {queue.map((item) => (
            <View key={item.key} style={styles.row}>
              <View style={styles.rowHead}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.title || fileNameOf({ uri: item.uri, name: item.name }) || 'Файл'}
                </Text>
                <Text style={[styles.badge, badgeStyle(item.status)]}>{badgeText(item)}</Text>
              </View>

              {item.status === 'pending' && (
                <View style={styles.fields}>
                  <TextInput
                    style={styles.input}
                    value={item.title}
                    onChangeText={(value) => patch(item.key, { title: value })}
                    placeholder={guessMeta(item.name).title}
                    placeholderTextColor={colors.dim}
                    editable={!busy}
                  />
                  <View style={styles.fieldRow}>
                    <TextInput
                      style={[styles.input, styles.inputHalf]}
                      value={item.artist}
                      onChangeText={(value) => patch(item.key, { artist: value })}
                      placeholder={guessMeta(item.name).artist ?? 'Исполнитель'}
                      placeholderTextColor={colors.dim}
                      editable={!busy}
                    />
                    <TextInput
                      style={[styles.input, styles.inputHalf]}
                      value={item.genre}
                      onChangeText={(value) => patch(item.key, { genre: value })}
                      placeholder="Жанр"
                      placeholderTextColor={colors.dim}
                      editable={!busy}
                    />
                  </View>
                </View>
              )}

              {item.status === 'uploading' && (
                <View style={styles.progressTrack}>
                  <View style={[styles.progressBar, { width: `${Math.max(2, item.progress)}%` }]} />
                  <Text style={styles.progressText}>{item.progress}%</Text>
                </View>
              )}

              {item.message ? <Text style={styles.message}>{item.message}</Text> : null}

              {item.status !== 'uploading' && (
                <Pressable
                  onPress={() => setQueue((prev) => prev.filter((row) => row.key !== item.key))}
                  hitSlop={8}
                >
                  <Text style={styles.remove}>Убрать</Text>
                </Pressable>
              )}
            </View>
          ))}

          {queue.length > 0 && (
            <Text style={styles.hint}>
              Повтор уже загруженного файла не создаёт дубль: сервер отвечает «уже в библиотеке».
              Так можно заливать одну и ту же запись с нескольких устройств.
            </Text>
          )}
        </ScrollView>

        {busy && (
          <View style={styles.busyBar}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.busyText}>Не закрывайте приложение: файл отправляется</Text>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function badgeText(item: QueueItem): string {
  switch (item.status) {
    case 'uploading': return 'отправляю';
    case 'done': return 'загружен';
    case 'duplicate': return 'уже есть';
    case 'failed': return 'ошибка';
    default: return item.size ? `${Math.max(1, Math.round(item.size / 1024 / 1024))} МБ` : 'в очереди';
  }
}

function badgeStyle(status: QueueItem['status']) {
  if (status === 'done' || status === 'duplicate') return { color: colors.ok };
  if (status === 'failed') return { color: colors.danger };
  if (status === 'uploading') return { color: colors.accentSoft };
  return { color: colors.muted };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    paddingHorizontal: 18, paddingTop: 12, paddingBottom: 10,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 12, marginTop: 4 },
  close: { paddingHorizontal: 10, paddingVertical: 6 },
  closeText: { color: colors.accent, fontSize: 14 },
  actions: { flexDirection: 'row', gap: 10, paddingHorizontal: 18, paddingBottom: 12 },
  pickButton: {
    flex: 1, paddingVertical: 12, borderRadius: radius.md, alignItems: 'center',
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border,
  },
  pickButtonText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  uploadButton: {
    flex: 1, paddingVertical: 12, borderRadius: radius.md, alignItems: 'center', backgroundColor: colors.accent,
  },
  uploadButtonText: { color: colors.accentInk, fontSize: 14, fontWeight: '700' },
  buttonDisabled: { opacity: 0.4 },
  empty: { paddingHorizontal: 18, paddingVertical: 28, gap: 8 },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  emptyText: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  row: {
    marginHorizontal: 18, marginBottom: 10, padding: 12, gap: 8,
    backgroundColor: colors.panel, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowName: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  badge: { fontSize: 11, fontWeight: '600' },
  fields: { gap: 8 },
  fieldRow: { flexDirection: 'row', gap: 8 },
  input: {
    backgroundColor: colors.panelAlt, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border,
    color: colors.text, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13,
  },
  inputHalf: { flex: 1 },
  progressTrack: {
    height: 22, borderRadius: radius.sm, backgroundColor: colors.panelAlt,
    justifyContent: 'center', overflow: 'hidden',
  },
  progressBar: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.accent },
  progressText: { color: colors.text, fontSize: 11, paddingLeft: 8 },
  message: { color: colors.muted, fontSize: 12 },
  remove: { color: colors.danger, fontSize: 12 },
  hint: { color: colors.dim, fontSize: 11, lineHeight: 16, paddingHorizontal: 18, paddingTop: 4 },
  error: { color: colors.danger, fontSize: 12, paddingHorizontal: 18, paddingBottom: 8 },
  busyBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingVertical: 12,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  busyText: { color: colors.muted, fontSize: 12 },
});
