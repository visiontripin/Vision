import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import {
  EMPTY_STATUS,
  describeStatus,
  libraryMode,
  serverUrl,
  type ServerStatus,
} from '../lib/embedded-server';
import { isRuntimeAvailable, readServerState, runtimeVersion, startEmbeddedServer, stopEmbeddedServer } from '../runtime';
import { TesterScreen } from './TesterScreen';
import { colors, radius } from '../theme';

/**
 * «Сервер на телефоне» — экран, которого раньше не было.
 *
 * Правило простое: пользователь не должен видеть молчание. Здесь всегда видно
 * одно из пяти состояний (работает, запускается, не запустился, остановлен, нет
 * рантайма), адрес, версия Node и причина отказа. Кнопка «Тестер» открывает
 * встроенную проверку прямо в приложении — без компьютера и без `adb`.
 */
export function ServerStatusScreen({
  visible,
  onClose,
  syncEnabled,
  onOpenTester,
}: {
  visible: boolean;
  onClose: () => void;
  /** включена ли общая библиотека (вариант D) — показываем оба режима вместе */
  syncEnabled: boolean;
  onOpenTester: (url: string) => void;
}) {
  const [status, setStatus] = useState<ServerStatus>(EMPTY_STATUS);
  const [available, setAvailable] = useState(isRuntimeAvailable());
  const [busy, setBusy] = useState(false);
  const [testerOpen, setTesterOpen] = useState(false);

  const refresh = useCallback(async () => {
    const version = await runtimeVersion();
    // state.json — источник правды о том, что реально произошло: JNI-вызов мог
    // вернуть адрес, а процесс — упасть сразу после этого.
    const file = await readServerState();
    setAvailable(isRuntimeAvailable());
    setStatus((previous) => {
      const phase = file?.phase ?? previous.phase;
      return {
        ...previous,
        phase,
        runtime: version ?? previous.runtime,
        error: file?.error ?? previous.error,
        url: phase === 'running' ? previous.url ?? serverUrl(previous.port) : null,
      };
    });
  }, []);

  // Пока экран открыт, состояние обновляется: запуск занимает секунды, и
  // «ничего не происходит» — худшее, что можно показать.
  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [visible, refresh]);

  const start = async () => {
    setBusy(true);
    const next = await startEmbeddedServer({
      onPhase: (phase, error) => setStatus((previous) => ({ ...previous, phase, error: error ?? null })),
    });
    setStatus(next);
    setBusy(false);
  };

  const stop = async () => {
    setBusy(true);
    await stopEmbeddedServer();
    setStatus((previous) => ({ ...previous, phase: 'stopped', url: null, error: null }));
    setBusy(false);
  };

  const described = describeStatus(status);
  const running = status.phase === 'running';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>Сервер на телефоне</Text>
          <Pressable onPress={onClose} style={styles.close} accessibilityLabel="Закрыть">
            <Text style={styles.closeText}>Закрыть</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.card}>
            <View style={styles.rowBetween}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{described.title}</Text>
                <Text style={styles.cardDetail}>{described.detail}</Text>
              </View>
              {busy || status.phase === 'starting' ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <View style={[styles.dot, { backgroundColor: running ? colors.ok : colors.dim }]} />
              )}
            </View>

            {status.url ? (
              <Text selectable style={styles.url}>
                {status.url}
              </Text>
            ) : null}

            {status.error ? <Text style={styles.error}>{status.error}</Text> : null}
          </View>

          <Text style={styles.hint}>
            Сервер внутри телефона — это полный API Vision на устройстве: библиотека, обложки,
            статистика. Он не заменяет общую библиотеку, а дополняет её: треки других устройств
            по-прежнему приходят через реестр в любой сети.
          </Text>
          <Text style={styles.mode}>
            Сейчас: {libraryMode(status, syncEnabled)}
          </Text>

          <View style={styles.actions}>
            <Pressable
              style={[styles.primary, (!available || busy || running) && styles.disabled]}
              disabled={!available || busy || running}
              onPress={() => void start()}
            >
              <Text style={styles.primaryText}>{running ? 'Уже работает' : 'Запустить сервер'}</Text>
            </Pressable>
            <Pressable
              style={[styles.secondary, (!running || busy) && styles.disabled]}
              disabled={!running || busy}
              onPress={() => void stop()}
            >
              <Text style={styles.secondaryText}>Остановить</Text>
            </Pressable>
          </View>

          <Pressable
            style={[styles.tester, !running && styles.disabled]}
            disabled={!running}
            onPress={() => {
              setTesterOpen(true);
              if (status.url) onOpenTester(status.url);
            }}
          >
            <Text style={styles.testerText}>Открыть тестер</Text>
            <Text style={styles.testerHint}>проверка запросов к серверу без компьютера</Text>
          </Pressable>

          {!available && (
            <Text style={styles.note}>
              В этой сборке нет Node-рантайма. Лента, плеер, файлы на телефоне и общая
              библиотека работают; встроенный сервер появится в сборке с Node.
            </Text>
          )}

          <Text style={styles.hint}>
            Что важно знать: сервер слушает только сам телефон (127.0.0.1). Он живёт, пока
            приложение в памяти — Android останавливает фоновые процессы, и это нормально:
            музыка играет через системный плеер, а сервер нужен для API и диагностики.
          </Text>
        </ScrollView>
      </SafeAreaView>

      {testerOpen && status.url ? (
        <TesterScreen visible onClose={() => setTesterOpen(false)} embeddedUrl={status.url} />
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  close: { paddingHorizontal: 12, paddingVertical: 6 },
  closeText: { color: colors.muted, fontSize: 13.5 },
  body: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
  card: { backgroundColor: colors.panel, borderRadius: radius.lg, padding: 16, gap: 10, borderWidth: 1, borderColor: colors.border },
  rowBetween: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  cardDetail: { color: colors.muted, fontSize: 13, marginTop: 3 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  url: { color: colors.accentSoft, fontSize: 14, fontFamily: 'monospace' },
  error: { color: colors.danger, fontSize: 12.5 },
  hint: { color: colors.dim, fontSize: 12.5, lineHeight: 18 },
  mode: { color: colors.text, fontSize: 13.5 },
  actions: { flexDirection: 'row', gap: 10 },
  primary: { flex: 1, backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center' },
  primaryText: { color: colors.accentInk, fontWeight: '800', fontSize: 14.5 },
  secondary: { flex: 1, backgroundColor: colors.panel, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  secondaryText: { color: colors.text, fontWeight: '600', fontSize: 14.5 },
  disabled: { opacity: 0.45 },
  tester: { backgroundColor: colors.panelAlt, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 16, borderWidth: 1, borderColor: colors.border, gap: 3 },
  testerText: { color: colors.text, fontWeight: '700', fontSize: 15 },
  testerHint: { color: colors.dim, fontSize: 12 },
  note: { color: colors.muted, fontSize: 12.5, backgroundColor: colors.panelAlt, padding: 12, borderRadius: radius.md },
});
