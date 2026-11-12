import { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { api, apiBase, setApiBase } from '../api';
import { normalizeBase, saveBase } from '../config';
import { formatBytes } from '../lib/format';
import { useLocalLibrary } from '../local';
import { colors, radius } from '../theme';

/**
 * Необязательное подключение к домашнему серверу.
 *
 * Экран больше **не** первый: приложение работает без сервера, и сюда человек
 * попадает только сам — из «Добавить музыку» или настроек. Поэтому здесь нет
 * ни слова «войти», ни обязательных полей: это добавление второго источника,
 * а не вход в приложение.
 */
export function ServerScreen({ visible, onClose, onConnected }: {
  visible: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const local = useLocalLibrary();
  const [base, setBase] = useState(apiBase());
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);

  useEffect(() => {
    if (visible) {
      setBase(apiBase());
      setError(null);
    }
  }, [visible]);

  const connect = async () => {
    const normalized = normalizeBase(base);
    if (!normalized) {
      setError('Например: 192.168.1.10:4000');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setApiBase(normalized);
      const { token } = await api.login(password);
      api.setToken(token);
      await saveBase(normalized);
      await onConnected();
      Alert.alert('Подключено', 'Треки с сервера доступны в разделе «Сервер».');
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Сервер не ответил';
      setError(
        /unauthor/i.test(message)
          ? 'Неверный пароль'
          : /network|failed|timeout/i.test(message)
            ? 'Сервер не отвечает. Проверьте, что он запущен и вы в той же Wi-Fi.'
            : message
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Назад">
            <Text style={styles.closeText}>←</Text>
          </Pressable>
          <Text style={styles.title}>Домашний сервер</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Это необязательно</Text>
            <Text style={styles.hint}>
              Музыка на этом телефоне играет без сервера. Сервер нужен, только если у вас есть
              своя библиотека на компьютере или в Termux и вы хотите слушать её отсюда.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Моя музыка на телефоне</Text>
            <Text style={styles.hint}>
              {local.tracks.length} треков · {formatBytes(local.bytes)}
            </Text>
            <Pressable style={styles.secondary} onPress={() => setStatsOpen(true)}>
              <Text style={styles.secondaryText}>Посмотреть статистику</Text>
            </Pressable>
          </View>

          <Text style={styles.label}>Адрес сервера</Text>
          <TextInput
            style={styles.input}
            value={base}
            onChangeText={setBase}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="192.168.1.10:4000"
            placeholderTextColor={colors.dim}
          />
          <Text style={styles.hint}>Порт по умолчанию — 4000. Адрес виден в Termux или в приложении «Vision Server».</Text>

          <Text style={styles.label}>Пароль</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Пароль сервера"
            placeholderTextColor={colors.dim}
            onSubmitEditing={() => void connect()}
            returnKeyType="go"
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={[styles.primary, (busy || !password) && { opacity: 0.45 }]}
            onPress={() => void connect()}
            disabled={busy || !password}
          >
            {busy ? <ActivityIndicator color={colors.accentInk} /> : <Text style={styles.primaryText}>Подключиться</Text>}
          </Pressable>
        </ScrollView>
      </SafeAreaView>

      <StatsScreen visible={statsOpen} onClose={() => setStatsOpen(false)} />
    </Modal>
  );
}

/**
 * Статистика на телефоне: что слушал и сколько. Отдельного приложения не нужно
 * — это два счётчика, которые всегда под рукой.
 */
export function StatsScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const local = useLocalLibrary();
  const minutes = Math.round(local.stats.weekSeconds / 60);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Назад">
            <Text style={styles.closeText}>←</Text>
          </Pressable>
          <Text style={styles.title}>Что я слушаю</Text>
          <View style={{ width: 24 }} />
        </View>

        <FlatList
          data={local.stats.top}
          keyExtractor={(item) => item.trackId}
          contentContainerStyle={{ paddingBottom: 40 }}
          ListHeaderComponent={
            <View style={styles.card}>
              <Text style={styles.big}>{minutes >= 60 ? `${(minutes / 60).toFixed(1)} ч` : `${minutes} мин`}</Text>
              <Text style={styles.hint}>за последние 7 дней · {local.stats.played} прослушиваний</Text>
            </View>
          }
          renderItem={({ item, index }) => (
            <View style={styles.statRow}>
              <Text style={styles.rank}>{index + 1}</Text>
              <Text numberOfLines={1} style={styles.statTitle}>
                {item.title}
              </Text>
              <Text style={styles.statCount}>{item.plays}×</Text>
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              Пока ничего не прослушано. Статистика появляется сама, как только вы включите музыку.
            </Text>
          }
        />
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
  card: {
    marginHorizontal: 18,
    marginTop: 14,
    padding: 16,
    borderRadius: radius.md,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  label: {
    color: colors.muted,
    fontSize: 11.5,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 20,
    marginBottom: 8,
    paddingHorizontal: 18,
  },
  hint: { color: colors.dim, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 0 },
  input: {
    marginHorizontal: 18,
    height: 48,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    backgroundColor: colors.panel,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  error: { color: colors.danger, fontSize: 13, marginTop: 12, paddingHorizontal: 18 },
  primary: {
    marginHorizontal: 18,
    marginTop: 18,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: colors.accentInk, fontWeight: '800', fontSize: 14.5 },
  secondary: {
    marginTop: 12,
    height: 42,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { color: colors.text, fontWeight: '600', fontSize: 13 },
  big: { color: colors.text, fontSize: 34, fontWeight: '800' },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rank: { color: colors.dim, fontSize: 13, width: 18 },
  statTitle: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  statCount: { color: colors.accentSoft, fontSize: 13, fontWeight: '700' },
  empty: { color: colors.muted, fontSize: 13, textAlign: 'center', marginTop: 30, paddingHorizontal: 32, lineHeight: 19 },
});
