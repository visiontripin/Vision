import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { HOOK_SCRIPT, looksLikeAudio, titleFromUrl } from '../lib/link';
import { colors, radius } from '../theme';

/**
 * Добавление трека по ссылке (HTML-страница, прямой файл, YouTube-ссылка).
 *
 * Почему WebView, а не просто `fetch`: у большинства страниц звук спрятан за
 * скриптом, а не лежит в разметке, и без исполнения этого скрипта ссылку на файл
 * не достать. Внутри страницы работает перехватчик: он смотрит сетевые запросы
 * (`fetch`/`XHR`) и медиа-элементы, поэтому видит тот же адрес, по которому
 * браузер пошёл бы сам. Это честнее «угадывания» по тексту страницы.
 *
 * Правило продукта: приложение помогает **скачать то, к чему у человека есть
 * доступ**, и не обходит платные подписки и защиту от скачивания.
 */

export type LinkResult = { url: string; title: string; mime?: string };

export function LinkImportScreen({ visible, onClose, onAdd }: {
  visible: boolean;
  onClose: () => void;
  onAdd: (result: LinkResult) => Promise<void> | void;
}) {
  const [address, setAddress] = useState('');
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);


  useEffect(() => {
    if (!visible) {
      setFound([]);
      setError(null);
      setOpen(false);
    }
  }, [visible]);

  /**
   * Добавление по адресу. Прямой файл можно взять сразу; для страницы нужен
   * WebView — тогда открываем его и ищем звук на месте.
   */
  const start = useCallback(
    async (raw: string) => {
      const target = raw.trim();
      if (!target) return;
      const withScheme = /^https?:\/\//i.test(target) ? target : `https://${target}`;
      setError(null);
      setBusy(true);
      try {
        if (looksLikeAudio(withScheme)) {
          await onAdd({ url: withScheme, title: titleFromUrl(withScheme) });
          setAddress('');
          onClose();
          return;
        }
        setFound([]);
        setAddress(withScheme);
        setOpen(true);
      } finally {
        setBusy(false);
      }
    },
    [onAdd, onClose]
  );

  const addFound = useCallback(
    async (url: string) => {
      setBusy(true);
      try {
        await onAdd({ url, title: titleFromUrl(url) });
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Не удалось добавить трек');
      } finally {
        setBusy(false);
      }
    },
    [onAdd, onClose]
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Назад">
            <Text style={styles.closeText}>←</Text>
          </Pressable>
          <Text style={styles.title}>По ссылке</Text>
          <View style={{ width: 24 }} />
        </View>

        {!open ? (
          <View style={{ paddingHorizontal: 18 }}>
            <Text style={styles.hint}>
              Вставьте ссылку на страницу с треком или на сам аудиофайл. Приложение откроет
              страницу и найдёт звук — без ручного поиска адреса в исходниках.
            </Text>
            <TextInput
              style={styles.input}
              value={address}
              onChangeText={setAddress}
              placeholder="https://…"
              placeholderTextColor={colors.dim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onSubmitEditing={() => void start(address)}
              returnKeyType="go"
            />
            <Pressable
              style={[styles.primary, (busy || !address.trim()) && { opacity: 0.45 }]}
              onPress={() => void start(address)}
              disabled={busy || !address.trim()}
            >
              {busy ? <ActivityIndicator color={colors.accentInk} /> : <Text style={styles.primaryText}>Открыть</Text>}
            </Pressable>
            <Text style={styles.note}>
              Скачивайте только то, что вам разрешено слушать офлайн. Приложение не обходит
              подписки и защиту от скачивания.
            </Text>
            {error && <Text style={styles.error}>{error}</Text>}
          </View>
        ) : (
          <>
            <View style={styles.foundBar}>
              <Text style={styles.foundTitle}>
                {found.length ? `Найдено звуков: ${found.length}` : 'Ищем звук на странице…'}
              </Text>
              {found.slice(0, 3).map((url) => (
                <Pressable key={url} style={styles.foundRow} onPress={() => void addFound(url)}>
                  <Text numberOfLines={1} style={styles.foundUrl}>
                    {titleFromUrl(url)}
                  </Text>
                  <Text style={styles.foundAdd}>{busy ? '…' : '＋'}</Text>
                </Pressable>
              ))}
              {found.length > 0 && (
                <Text style={styles.foundHint}>
                  Если нужного трека нет, запустите воспроизведение на странице — адрес появится здесь.
                </Text>
              )}
            </View>
            <WebView
              source={{ uri: address }}
              injectedJavaScript={HOOK_SCRIPT}
              mediaPlaybackRequiresUserAction
              allowsInlineMediaPlayback
              javaScriptEnabled
              domStorageEnabled
              startInLoadingState
              onError={() => setError('Страница не открылась. Проверьте ссылку и интернет.')}
              onMessage={(event) => {
                try {
                  const payload = JSON.parse(event.nativeEvent.data) as { type: string; url: string };
                  if (!payload?.url) return;
                  // Показываем только то, что похоже на звук: иначе список забьётся
                  // служебными запросами страницы.
                  const candidate = payload.url;
                  const isAudio = looksLikeAudio(candidate) || payload.type === 'media';
                  if (!isAudio) return;
                  setFound((previous) => (previous.includes(candidate) || previous.length >= 8 ? previous : [...previous, candidate]));
                } catch {
                  /* не наше сообщение */
                }
              }}
              style={styles.web}
            />
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  title: { color: colors.text, fontSize: 19, fontWeight: '800' },
  closeText: { color: colors.muted, fontSize: 22 },
  hint: { color: colors.muted, fontSize: 13.5, lineHeight: 20, marginTop: 6 },
  input: {
    marginTop: 16,
    height: 48,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    backgroundColor: colors.panel,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  primary: {
    marginTop: 14,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: colors.accentInk, fontWeight: '800', fontSize: 14.5 },
  note: { color: colors.dim, fontSize: 11.5, lineHeight: 17, marginTop: 14 },
  error: { color: colors.danger, fontSize: 13, marginTop: 12 },
  foundBar: {
    paddingHorizontal: 18,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  foundTitle: { color: colors.text, fontSize: 13.5, fontWeight: '700', marginBottom: 6 },
  foundRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  foundUrl: { flex: 1, color: colors.accentSoft, fontSize: 13 },
  foundAdd: { color: colors.accent, fontSize: 18, fontWeight: '800' },
  foundHint: { color: colors.dim, fontSize: 11.5, lineHeight: 16, marginTop: 4 },
  web: { flex: 1, backgroundColor: colors.panel },
});
