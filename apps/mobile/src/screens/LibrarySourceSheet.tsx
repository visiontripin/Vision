import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';

/**
 * «Откуда взять музыку» — один список источников, чтобы человек не гадал, что
 * делать на пустом экране.
 *
 * Первый пункт — файлы с телефона: это работает всегда и без сети. Сервер идёт
 * последним и подписан «необязательно»: он нужен только тем, у кого есть
 * домашний сервер Vision, и не должен выглядеть как обязательный шаг.
 */
export function LibrarySourceSheet({
  visible,
  onClose,
  onPickFiles,
  onPickLink,
  onOpenServer,
}: {
  visible: boolean;
  onClose: () => void;
  onPickFiles: () => void;
  onPickLink: () => void;
  onOpenServer: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.grabber} />
          <Text style={styles.title}>Добавить музыку</Text>

          <Pressable style={styles.row} onPress={onPickFiles}>
            <View style={styles.icon}>
              <Text style={styles.iconText}>♫</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Файлы с телефона</Text>
              <Text style={styles.rowSub}>MP3, M4A, FLAC, WAV — играет без интернета</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>

          <Pressable style={styles.row} onPress={onPickLink}>
            <View style={styles.icon}>
              <Text style={styles.iconText}>⛓</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>По ссылке</Text>
              <Text style={styles.rowSub}>Страница с треком или прямой аудиофайл</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>

          <Pressable style={styles.row} onPress={onOpenServer}>
            <View style={[styles.icon, styles.iconMuted]}>
              <Text style={styles.iconTextMuted}>⇄</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>
                Домашний сервер <Text style={styles.badge}>необязательно</Text>
              </Text>
              <Text style={styles.rowSub}>Своя библиотека на ПК или в Termux, доступ по Wi-Fi</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>

          <Pressable style={styles.close} onPress={onClose}>
            <Text style={styles.closeText}>Закрыть</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.panel,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 28,
    gap: 4,
  },
  grabber: { alignSelf: 'center', width: 42, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 10 },
  title: { color: colors.text, fontSize: 19, fontWeight: '800', marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  icon: {
    width: 42,
    height: 42,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconMuted: { backgroundColor: '#1c1c25' },
  iconText: { color: colors.accentInk, fontSize: 19, fontWeight: '800' },
  iconTextMuted: { color: colors.muted, fontSize: 19, fontWeight: '700' },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  rowSub: { color: colors.muted, fontSize: 12, marginTop: 2, lineHeight: 17 },
  badge: { color: colors.dim, fontSize: 10.5, fontWeight: '700' },
  chevron: { color: colors.dim, fontSize: 20 },
  close: { marginTop: 10, paddingVertical: 12, alignItems: 'center' },
  closeText: { color: colors.muted, fontSize: 13.5, fontWeight: '600' },
});
