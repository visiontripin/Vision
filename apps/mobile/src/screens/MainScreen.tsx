import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { colors, radius } from '../theme';
import { TrackCard } from '../components/TrackCard';
import { MiniPlayer } from '../components/MiniPlayer';
import { usePlayer } from '../player';
import { useLocalLibrary } from '../local';
import { useSync } from '../sync';
import { formatBytes } from '../lib/format';
import { NowPlaying } from './NowPlaying';
import { SettingsScreen } from './SettingsScreen';
import { ServerStatusScreen } from './ServerStatusScreen';
import { ServerScreen } from './ServerScreen';
import { LinkImportScreen } from './LinkImportScreen';

type Tab = 'feed' | 'library';

/**
 * Главный экран: лента общей библиотеки и «на телефоне».
 *
 * Лента — первая вкладка, потому что именно она отвечает на ожидание «загрузил
 * на одном телефоне — вижу на другом». Вкладка «На телефоне» — то, что играет без
 * сети, и там же появляется только что импортированное.
 *
 * Внизу — панель как в референсе: волна-прогресс, play, название, лайк.
 */
export function MainScreen() {
  const local = useLocalLibrary();
  const sync = useSync();
  const player = usePlayer();

  const [tab, setTab] = useState<Tab>('feed');
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);
  const [embeddedOpen, setEmbeddedOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const needle = query.trim().toLowerCase();

  /* ---- лента ---- */
  const feedItems = useMemo(
    () =>
      sync.feed.filter((item) =>
        needle ? `${item.title} ${item.artist} ${item.deviceName}`.toLowerCase().includes(needle) : true
      ),
    [sync.feed, needle]
  );

  /* ---- свои файлы ---- */
  const localItems = useMemo(
    () => local.tracks.filter((track) => (needle ? `${track.title} ${track.artist}`.toLowerCase().includes(needle) : true)),
    [local.tracks, needle]
  );

  const importFiles = useCallback(async () => {
    setImporting(true);
    try {
      const result = await local.importFiles();
      if (result.error) {
        Alert.alert('Не удалось выбрать файлы', result.error);
        return;
      }
      if (result.total === 0) return;
      if (result.added === 0) {
        Alert.alert('Новых файлов нет', 'Эти треки уже есть в библиотеке.');
        return;
      }
      // Загрузили — сразу показываем другим устройствам, не ждём таймера.
      void sync.refresh();
      Alert.alert('Готово', `Добавлено треков: ${result.added}. Они появятся на других ваших устройствах.`);
    } finally {
      setImporting(false);
    }
  }, [local, sync]);

  /** Меню трека: системное, его не срезает край списка (та же ошибка была в вебе). */
  const openMenu = useCallback(
    (title: string, actions: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[]) => {
      Alert.alert(title, undefined, [{ text: 'Закрыть', style: 'cancel' }, ...actions]);
    },
    []
  );

  const playLocal = useCallback(
    (id: string) => {
      const track = local.tracks.find((candidate) => candidate.id === id);
      if (track) player.playTrack(track, local.tracks);
    },
    [local.tracks, player]
  );

  const header = (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>VISION</Text>
          <Text style={styles.title}>{tab === 'feed' ? 'Лента' : 'На телефоне'}</Text>
        </View>
        <Pressable onPress={() => void importFiles()} style={styles.addButton} accessibilityLabel="Добавить музыку">
          <Text style={styles.addText}>{importing ? '…' : '＋'}</Text>
        </Pressable>
        <Pressable onPress={() => setSettingsOpen(true)} style={styles.avatar} accessibilityLabel="Настройки">
          <Text style={styles.avatarText}>{(sync.deviceName || 'V').slice(0, 1).toUpperCase()}</Text>
        </Pressable>
      </View>

      <View style={styles.searchRow}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder={`Поиск ${tab === 'feed' ? feedItems.length : localItems.length} треков`}
          placeholderTextColor={colors.dim}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>

      <View style={styles.tabs}>
        {(['feed', 'library'] as Tab[]).map((value) => (
          <Pressable key={value} onPress={() => setTab(value)} style={[styles.tab, tab === value && styles.tabActive]}>
            <Text style={[styles.tabText, tab === value && styles.tabTextActive]}>
              {value === 'feed' ? 'Лента' : `На телефоне${localItems.length ? ` (${localItems.length})` : ''}`}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.statusRow}>
        <View style={[styles.dot, sync.online && sync.syncUrl ? styles.dotOn : styles.dotOff]} />
        <Pressable style={{ flex: 1 }} onPress={() => setSettingsOpen(true)}>
          <Text numberOfLines={1} style={styles.status}>
            {sync.statusText}
          </Text>
        </Pressable>
        <Text style={styles.bytes}>{formatBytes(local.bytes)}</Text>
      </View>
    </View>
  );

  const empty = (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{tab === 'feed' ? 'Лента пока пуста' : 'Здесь будет ваша музыка'}</Text>
      <Text style={styles.emptyText}>
        {tab === 'feed'
          ? 'Добавьте музыку на этом телефоне или на другом — треки появятся здесь и будут видны на всех ваших устройствах с приложением.'
          : 'Добавьте файлы с телефона. Они играют без интернета и сразу видны другим устройствам.'}
      </Text>
      <Pressable style={styles.emptyButton} onPress={() => void importFiles()}>
        <Text style={styles.emptyButtonText}>{importing ? 'Открываю…' : '＋ Добавить файлы'}</Text>
      </Pressable>
      <Pressable style={styles.ghost} onPress={() => setLinkOpen(true)}>
        <Text style={styles.ghostText}>Добавить по ссылке</Text>
      </Pressable>
    </View>
  );

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />

      {tab === 'feed' ? (
        <FlatList
          data={feedItems}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 150 }}
          refreshControl={
            <RefreshControl refreshing={sync.syncing} onRefresh={() => void sync.refresh()} tintColor={colors.accent} />
          }
          renderItem={({ item }) => {
            const track = local.tracks.find((candidate) => candidate.id === item.id);
            return (
              <TrackCard
                title={item.title}
                artist={item.artist}
                duration={item.duration}
                plays={track?.plays}
                active={player.current?.id === item.id}
                playing={player.playing}
                sourceLabel={item.mine ? 'на этом телефоне' : item.deviceName}
                unavailable={!item.mine && !item.downloadable}
                onPress={() => (item.mine ? playLocal(item.id) : void sync.fetchTrack(item.id))}
                onMenu={() => sync.explain(item.id)}
                onLongPress={() => sync.explain(item.id)}
              />
            );
          }}
          ListEmptyComponent={local.ready ? empty : <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />}
        />
      ) : (
        <FlatList
          data={localItems}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 150 }}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={() => void sync.refresh()} tintColor={colors.accent} />
          }
          renderItem={({ item }) => (
            <TrackCard
              title={item.title}
              artist={item.artist}
              duration={item.duration}
              plays={item.plays}
              active={player.current?.id === item.id}
              playing={player.playing}
              sourceLabel="файл на телефоне"
              onPress={() => playLocal(item.id)}
              onMenu={() =>
                openMenu(item.title, [
                  {
                    text: 'Играть следующим',
                    onPress: () => {
                      player.playTrack(item, local.tracks);
                      player.next();
                    },
                  },
                  {
                    text: 'В плейлист…',
                    onPress: () => {
                      const create = () => void local.createPlaylist(item.title).then((id) => local.addToPlaylist(id, item.id));
                      if (!local.playlists.length) {
                        create();
                        return;
                      }
                      Alert.alert('Добавить в плейлист', item.title, [
                        { text: 'Отмена', style: 'cancel' },
                        ...local.playlists.slice(0, 4).map((playlist) => ({
                          text: playlist.name,
                          onPress: () => void local.addToPlaylist(playlist.id, item.id),
                        })),
                        { text: '＋ Новый', onPress: create },
                      ]);
                    },
                  },
                  {
                    text: 'Убрать из библиотеки',
                    style: 'destructive',
                    onPress: () =>
                      Alert.alert('Убрать из библиотеки?', `${item.title}\n\nФайл на телефоне останется.`, [
                        { text: 'Отмена', style: 'cancel' },
                        { text: 'Убрать', style: 'destructive', onPress: () => void local.removeTrack(item.id) },
                      ]),
                  },
                ])
              }
            />
          )}
          ListEmptyComponent={local.ready ? empty : <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />}
        />
      )}

      <View style={styles.bottom}>
        <MiniPlayer cover={local.coverOf(player.current?.id ?? '') ?? undefined} onOpen={() => setNowPlayingOpen(true)} />
      </View>

      <NowPlaying
        visible={nowPlayingOpen}
        cover={local.coverOf(player.current?.id ?? '') ?? undefined}
        onClose={() => setNowPlayingOpen(false)}
        onDownload={() => undefined}
        queueLength={player.queue.length}
        onOpenQueue={() => {
          setNowPlayingOpen(false);
          setTab('library');
        }}
      />

      <LinkImportScreen
        visible={linkOpen}
        onClose={() => setLinkOpen(false)}
        onAdd={async ({ url, title }) => {
          const id = await local.addFromLink({ url, title });
          if (!id) throw new Error('Не удалось добавить трек');
          void sync.refresh();
        }}
      />

      <ServerScreen visible={serverOpen} onClose={() => setServerOpen(false)} onConnected={() => setServerOpen(false)} />

      <ServerStatusScreen
        visible={embeddedOpen}
        onClose={() => setEmbeddedOpen(false)}
        syncEnabled={Boolean(sync.syncUrl)}
        onOpenTester={() => undefined}
      />

      <SettingsScreen
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLogout={() => undefined}
        onOpenServer={() => {
          setSettingsOpen(false);
          setServerOpen(true);
        }}
        onImport={() => {
          setSettingsOpen(false);
          void importFiles();
        }}
        onOpenEmbedded={() => {
          setSettingsOpen(false);
          setEmbeddedOpen(true);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  headerTop: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  kicker: { color: colors.accent, fontSize: 11, fontWeight: '800', letterSpacing: 3 },
  title: { color: colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -1, marginTop: 2 },
  addButton: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addText: { color: colors.accentInk, fontSize: 20, fontWeight: '800' },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.accentSoft, fontWeight: '800', fontSize: 15 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 46,
    marginTop: 14,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchIcon: { color: colors.dim, fontSize: 17 },
  search: { flex: 1, color: colors.text, fontSize: 14.5, padding: 0 },
  tabs: { flexDirection: 'row', gap: 8, marginTop: 12 },
  tab: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.panel },
  tabActive: { backgroundColor: colors.text },
  tabText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  tabTextActive: { color: '#0b0b10' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotOn: { backgroundColor: colors.ok },
  dotOff: { backgroundColor: colors.dim },
  status: { color: colors.muted, fontSize: 12 },
  bytes: { color: colors.dim, fontSize: 11.5 },
  empty: { paddingHorizontal: 28, paddingTop: 36, alignItems: 'stretch' },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  emptyText: { color: colors.muted, fontSize: 13.5, lineHeight: 20, textAlign: 'center', marginTop: 8 },
  emptyButton: {
    marginTop: 18,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyButtonText: { color: colors.accentInk, fontWeight: '800', fontSize: 14.5 },
  ghost: { marginTop: 10, paddingVertical: 10, alignItems: 'center' },
  ghostText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
