import { useEffect, useState } from 'react';
import {
  Alert, FlatList, Modal, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, apiBase, setApiBase } from '../api';
import { KEYS, normalizeBase, saveBase } from '../config';
import { useDownloads } from '../downloads';
import { formatBytes } from '../lib/format';
import { colors, radius } from '../theme';

/** Настройки: адрес сервера, выход, офлайн-копии и место на устройстве. */
export function SettingsScreen({
  visible,
  onClose,
  onLogout,
  onReload,
}: {
  visible: boolean;
  onClose: () => void;
  onLogout: () => void;
  onReload: () => Promise<void> | void;
}) {
  const downloads = useDownloads();
  const [base, setBase] = useState(apiBase());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) setBase(apiBase());
  }, [visible]);

  const save = async () => {
    const normalized = normalizeBase(base);
    if (!normalized) {
      Alert.alert('Адрес пустой', 'Например: http://192.168.1.10:4000');
      return;
    }
    setBusy(true);
    try {
      setApiBase(normalized);
      await saveBase(normalized);
      await api.me();
      await onReload();
      Alert.alert('Готово', `Сервер: ${normalized}`);
      onClose();
    } catch (cause) {
      Alert.alert('Сервер не ответил', cause instanceof Error ? cause.message : 'Проверьте адрес и Wi-Fi');
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    Alert.alert('Выйти из аккаунта?', 'Офлайн-копии останутся на устройстве.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Выйти',
        style: 'destructive',
        onPress: async () => {
          api.setToken(null);
          await AsyncStorage.removeItem(KEYS.token);
          onClose();
          onLogout();
        },
      },
    ]);
  };

  const clearDownloads = () => {
    Alert.alert('Удалить все офлайн-копии?', `Освободится ${formatBytes(downloads.totalBytes)}`, [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => void downloads.clear() },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>Настройки</Text>
          <Pressable onPress={onClose} style={styles.close} accessibilityLabel="Закрыть">
            <Text style={styles.closeText}>Закрыть</Text>
          </Pressable>
        </View>

        <FlatList
          data={Object.values(downloads.entries).sort((a, b) => b.at - a.at)}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 32 }}
          ListHeaderComponent={
            <View>
              <Text style={styles.label}>Адрес сервера</Text>
              <TextInput
                style={styles.input}
                value={base}
                onChangeText={setBase}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="http://192.168.1.10:4000"
                placeholderTextColor={colors.dim}
              />
              <Text style={styles.hint}>Домашняя сеть или Tailscale. Порт по умолчанию 4000.</Text>

              <Pressable style={[styles.primary, busy && { opacity: 0.5 }]} onPress={() => void save()} disabled={busy}>
                <Text style={styles.primaryText}>{busy ? 'Проверяем…' : 'Сохранить и проверить'}</Text>
              </Pressable>

              <View style={styles.sectionRow}>
                <Text style={styles.label}>
                  Офлайн-копии · {downloads.count} · {formatBytes(downloads.totalBytes)}
                </Text>
                {downloads.count > 0 && (
                  <Pressable onPress={clearDownloads}>
                    <Text style={styles.link}>очистить</Text>
                  </Pressable>
                )}
              </View>

              {downloads.count === 0 && (
                <Text style={styles.hint}>
                  Скачанные треки играют без сети. Кнопка ↓ есть в списке треков и в плеере.
                </Text>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.downloadRow}>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={styles.downloadTitle}>
                  {item.title}
                </Text>
                <Text numberOfLines={1} style={styles.downloadMeta}>
                  {item.artist} · {formatBytes(item.bytes)}
                </Text>
              </View>
              <Pressable onPress={() => void downloads.remove(item.id)} hitSlop={8} style={styles.remove}>
                <Text style={styles.removeText}>✕</Text>
              </Pressable>
            </View>
          )}
          ListFooterComponent={
            <View style={styles.footer}>
              <Pressable style={styles.dangerButton} onPress={logout}>
                <Text style={styles.dangerText}>Выйти из аккаунта</Text>
              </Pressable>
              <Text style={styles.hint}>
                Vision Audio · мобильный клиент. Сервер хранит библиотеку, телефон — только
                скачанные копии.
              </Text>
            </View>
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
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  close: { paddingHorizontal: 12, paddingVertical: 6 },
  closeText: { color: colors.muted, fontSize: 13.5 },
  label: {
    color: colors.muted,
    fontSize: 11.5,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 18,
    marginBottom: 8,
    paddingHorizontal: 20,
  },
  input: {
    marginHorizontal: 20,
    height: 48,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    backgroundColor: colors.panel,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  hint: { color: colors.dim, fontSize: 12, lineHeight: 17, marginTop: 8, paddingHorizontal: 20 },
  primary: {
    marginHorizontal: 20,
    marginTop: 14,
    height: 46,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: colors.accentInk, fontWeight: '800', fontSize: 14 },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 20,
  },
  link: { color: colors.accentSoft, fontSize: 12.5, marginTop: 10 },
  downloadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  downloadTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  downloadMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  remove: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  removeText: { color: colors.dim, fontSize: 14 },
  footer: { marginTop: 28, gap: 10 },
  dangerButton: {
    marginHorizontal: 20,
    height: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,107,107,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerText: { color: colors.danger, fontSize: 14, fontWeight: '600' },
});
