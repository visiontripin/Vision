import { useState } from 'react';
import {
  Alert, FlatList, Modal, Pressable, SafeAreaView, StyleSheet, Text, View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../api';
import { KEYS } from '../config';
import { useDownloads } from '../downloads';
import { useLocalLibrary } from '../local';
import { formatBytes } from '../lib/format';
import { colors, radius } from '../theme';

/** Настройки: источники музыки, офлайн-копии и отключение от сервера. */
export function SettingsScreen({
  visible,
  onClose,
  onLogout,
  onOpenServer,
  onImport,
}: {
  visible: boolean;
  onClose: () => void;
  onLogout: () => void;
  /** необязательное подключение к домашнему серверу */
  onOpenServer: () => void;
  /** добавить файлы с телефона */
  onImport: () => void;
}) {
  const downloads = useDownloads();
  const local = useLocalLibrary();
  const logout = () => {
    Alert.alert('Отключиться от сервера?', 'Музыка на телефоне останется на месте.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Отключиться',
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
              <Text style={styles.label}>Источники музыки</Text>
              <Pressable style={styles.secondary} onPress={() => onImport()}>
                <Text style={styles.secondaryText}>＋ Добавить файлы с телефона</Text>
              </Pressable>
              <Pressable style={styles.secondary} onPress={onOpenServer}>
                <Text style={styles.secondaryText}>Домашний сервер (необязательно)</Text>
              </Pressable>
              <Text style={styles.hint}>
                Файлы с телефона играют всегда и без интернета. Сервер нужен, только если у вас
                есть своя библиотека на компьютере.
              </Text>

              <View style={styles.sectionRow}>
                <Text style={styles.label}>
                  Офлайн-копии с сервера · {downloads.count} · {formatBytes(downloads.totalBytes)}
                </Text>
                {downloads.count > 0 && (
                  <Pressable onPress={clearDownloads}>
                    <Text style={styles.link}>очистить</Text>
                  </Pressable>
                )}
              </View>

              {downloads.count === 0 && (
                <Text style={styles.hint}>
                  Файлы на телефоне уже играют без сети: {local.tracks.length} треков ·{' '}
                  {formatBytes(local.bytes)}.
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
              <Pressable onPress={() => void downloads.remove(item.hash ?? item.id)} hitSlop={8} style={styles.remove}>
                <Text style={styles.removeText}>✕</Text>
              </Pressable>
            </View>
          )}
          ListFooterComponent={
            <View style={styles.footer}>
              <Pressable style={styles.dangerButton} onPress={logout}>
                <Text style={styles.dangerText}>Выйти с сервера</Text>
              </Pressable>
              <Text style={styles.hint}>
                Vision Audio · ваша музыка на этом телефоне. Библиотека и статистика
                хранятся на устройстве и никуда не отправляются.
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
  hint: { color: colors.dim, fontSize: 12, lineHeight: 17, marginTop: 8, paddingHorizontal: 20 },
  secondary: {
    marginHorizontal: 20,
    marginTop: 8,
    height: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { color: colors.text, fontWeight: '600', fontSize: 13.5 },
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
