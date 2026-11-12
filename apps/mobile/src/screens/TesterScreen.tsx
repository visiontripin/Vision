import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, SafeAreaView, ScrollView, Share, StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  checkUrl,
  checks,
  headersFor,
  judge,
  networkError,
  summarize,
  type CheckResult,
  type TesterContext,
} from '../lib/tester';
import { colors, radius } from '../theme';

/**
 * Тестер API внутри приложения.
 *
 * Зачем не «отдельное приложение»: тестировать надо там, где живёт проблема — на
 * телефоне, без компьютера, `adb` и Wi-Fi. Экран работает с любым адресом
 * (встроенный сервер, домашний по IP, туннель), поэтому годится и как проверка
 * внешнего сервера, если телефон его не видит.
 *
 * Проверки идут по очереди намеренно: параллельные запросы к только что
 * поднятому серверу дают ложные «сервер не отвечает».
 */
export function TesterScreen({
  visible,
  onClose,
  embeddedUrl,
}: {
  visible: boolean;
  onClose: () => void;
  /** адрес встроенного сервера — подставляется по умолчанию */
  embeddedUrl?: string;
}) {
  const [url, setUrl] = useState(embeddedUrl ?? 'http://127.0.0.1:4000');
  const [token, setToken] = useState('');
  const [results, setResults] = useState<CheckResult[]>([]);
  const [running, setRunning] = useState(false);
  const [runtime, setRuntime] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible && embeddedUrl) setUrl(embeddedUrl);
  }, [visible, embeddedUrl]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setResults([]);
    const ctx: TesterContext = { base: url.trim(), token: token.trim() || null };
    const done: CheckResult[] = [];

    for (const spec of checks(ctx)) {
      const started = Date.now();
      try {
        // Тело приводим к `BodyInit`: React Native принимает `Uint8Array`, но тип
        // `lib.dom` в этом проекте его не знает и ругается на `fetch`.
        const body = spec.body ? (spec.body(ctx) as unknown as BodyInit) : undefined;
        const response = await fetch(checkUrl(ctx.base, spec), {
          method: spec.method,
          headers: headersFor(spec, ctx.token),
          body,
        });
        const text = await response.text();
        let payload: unknown = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          /* не JSON — это нормально для файлов */
        }
        const result = judge(spec, response.status, text, payload);
        result.ms = Date.now() - started;
        done.push(result);
        if (spec.id === 'health' && payload && typeof payload === 'object') {
          const value = payload as Record<string, unknown>;
          setRuntime(typeof value.runtime === 'string' ? value.runtime : null);
          setVersion(typeof value.version === 'string' ? value.version : null);
        }
      } catch (failure) {
        done.push({
          id: spec.id,
          title: spec.title,
          status: 'fail',
          detail: networkError(failure),
          ms: Date.now() - started,
        });
        // Дальше идти нет смысла: если не ответил health, остальное — тот же сбой.
        setResults([...done]);
        setError(networkError(failure));
        setRunning(false);
        return;
      }
      setResults([...done]);
    }
    setRunning(false);
  }, [url, token]);

  const summary = summarize(results, { url: url.trim(), runtime, version });

  const share = () => {
    void Share.share({ message: summary.report }).catch(() => {
      /* поделиться нечем/некуда — отчёт всё равно на экране */
    });
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>Тестер</Text>
          <Pressable onPress={onClose} style={styles.close} accessibilityLabel="Закрыть">
            <Text style={styles.closeText}>Закрыть</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.label}>Адрес сервера</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://127.0.0.1:4000"
            placeholderTextColor={colors.dim}
          />
          <Text style={styles.label}>Токен (если сервер требует)</Text>
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="необязательно"
            placeholderTextColor={colors.dim}
          />

          <Pressable
            style={[styles.primary, running && styles.disabled]}
            disabled={running}
            onPress={() => void run()}
          >
            {running ? <ActivityIndicator color={colors.accentInk} /> : <Text style={styles.primaryText}>Проверить</Text>}
          </Pressable>

          {results.length > 0 && (
            <View style={styles.card}>
              {results.map((result) => (
                <View key={result.id} style={styles.resultRow}>
                  <Text style={[styles.mark, { color: result.status === 'ok' ? colors.ok : colors.danger }]}>
                    {result.status === 'ok' ? '✓' : result.status === 'fail' ? '✗' : '–'}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.resultTitle}>{result.title}</Text>
                    <Text style={styles.resultDetail}>
                      {result.http ? `HTTP ${result.http} · ` : ''}
                      {typeof result.ms === 'number' ? `${result.ms} мс · ` : ''}
                      {result.detail}
                    </Text>
                  </View>
                </View>
              ))}
              <Text style={[styles.summary, { color: summary.fail ? colors.danger : colors.ok }]}>
                {summary.headline}
              </Text>
            </View>
          )}

          {error && !running && results.length > 0 && results.every((r) => r.status !== 'ok') && (
            <Text style={styles.note}>
              Если это встроенный сервер — откройте «Сервер на телефоне» и запустите его. Если
              домашний — проверьте адрес и что телефон в той же сети.
            </Text>
          )}

          {results.length > 0 && (
            <Pressable style={styles.secondary} onPress={share}>
              <Text style={styles.secondaryText}>Поделиться отчётом</Text>
            </Pressable>
          )}

          <Text style={styles.hint}>
            Тестер отправляет шесть запросов: здоровье, список файлов, загрузку, скачивание,
            перемотку по Range и удаление. Файл `tester-check.mp3` создаётся и удаляется
            автоматически — в библиотеке мусора не остаётся.
          </Text>
        </ScrollView>
      </SafeAreaView>
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
  body: { paddingHorizontal: 20, paddingBottom: 40, gap: 8 },
  label: { color: colors.muted, fontSize: 12.5, marginTop: 8 },
  input: {
    backgroundColor: colors.panel, color: colors.text, borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 14.5, borderWidth: 1, borderColor: colors.border,
  },
  primary: { backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center', marginTop: 14 },
  primaryText: { color: colors.accentInk, fontWeight: '800', fontSize: 15 },
  disabled: { opacity: 0.5 },
  card: { backgroundColor: colors.panel, borderRadius: radius.lg, padding: 14, gap: 12, marginTop: 14, borderWidth: 1, borderColor: colors.border },
  resultRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  mark: { fontSize: 16, fontWeight: '800', width: 16 },
  resultTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  resultDetail: { color: colors.dim, fontSize: 12, marginTop: 2, lineHeight: 16 },
  summary: { fontSize: 14, fontWeight: '700', marginTop: 2 },
  secondary: { backgroundColor: colors.panel, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center', borderWidth: 1, borderColor: colors.border, marginTop: 10 },
  secondaryText: { color: colors.text, fontWeight: '600', fontSize: 14.5 },
  note: { color: colors.muted, fontSize: 12.5, backgroundColor: colors.panelAlt, padding: 12, borderRadius: radius.md, marginTop: 10 },
  hint: { color: colors.dim, fontSize: 12, lineHeight: 17, marginTop: 12 },
});
