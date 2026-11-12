import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { formatDuration, type Playlist, type Track } from '@vision/shared';
import { useCovers } from '../useCovers';
import { filterTracks } from '../useLibrary';
import { useDownloads } from '../downloads';
import { useLocalLibrary } from '../local';
import { usePlayer } from '../player';
import { formatBytes } from '../lib/format';
import { colors, radius } from '../theme';
import { TrackRow } from '../components/TrackRow';
import { MiniPlayer } from '../components/MiniPlayer';
import { NowPlaying } from './NowPlaying';
import { SettingsScreen } from './SettingsScreen';
import { LibrarySourceSheet } from './LibrarySourceSheet';
import { LinkImportScreen } from './LinkImportScreen';

type Tab = 'tracks' | 'playlists';

/**
 * Главный экран: музыка с этого телефона.
 *
 * Порядок в списке источников намеренно такой: сначала файлы устройства, потом
 * офлайн-копии, и только затем — необязательный сервер. Приложение должно
 * работать сразу после установки: «＋ Файлы» на пустом экране — это первый
 * осмысленный шаг, а не ввод адреса сервера.
 */
export function LibraryScreen({ onServerOpen, onLogout }: { onServerOpen: () => void; onLogout: () => void }) {
  const local = useLocalLibrary();
  const downloads = useDownloads();
  const player = usePlayer();

  const [tab, setTab] = useState<Tab>('tracks');
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [playlist, setPlaylist] = useState<{ info: Playlist; tracks: Track[] } | null>(null);
  const [importing, setImporting] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  /*
   * Источник списка: файлы устройства. Офлайн-копии серверных треков сюда не
   * подмешиваются — у них нет названия и исполнителя без сервера, и они уже
   * играют из раздела «Сервер» в настройках.
   */
  const tracks = local.tracks;
  const visibleTracks = useMemo(() => (playlist ? playlist.tracks : filterTracks(tracks, query)), [tracks, query, playlist]);
  const covers = useCovers(visibleTracks.map((track) => track.id));

  const currentCover = player.current ? covers[player.current.id] : undefined;

  /* ---- импорт файлов ---- */
  const importFiles = useCallback(async () => {
    setImporting(true);
    try {
      const result = await local.importFiles();
      if (result.error) {
        Alert.alert('Не удалось выбрать файлы', result.error);
      } else if (result.total === 0) {
        // Отмена выбора — не ошибка, ничего не говорим.
      } else if (result.added === 0) {
        Alert.alert('Новых файлов нет', 'Эти треки уже есть в библиотеке.');
      } else {
        Alert.alert('Готово', `Добавлено треков: ${result.added}.`);
      }
    } finally {
      setImporting(false);
    }
  }, [local]);

  const removeTrack = useCallback(
    (track: Track) => {
      Alert.alert('Убрать из библиотеки?', `${track.title} — ${track.artist}\n\nФайл на телефоне останется.`, [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Убрать', style: 'destructive', onPress: () => void local.removeTrack(track.id) },
      ]);
    },
    [local]
  );

  /**
   * Действия с треком. Меню — системное (`Alert`), а не самодельный sheet:
   * встроенное меню React Native на Android рисуется поверх всего, и его не
   * срезает `overflow` списка — ровно та ошибка, что была в вебе.
   */
  const trackActions = useCallback(
    (track: Track) => {
      const inPlaylist = playlist !== null;
      const buttons: { text: string; style?: 'cancel' | 'destructive' | 'default'; onPress?: () => void }[] = [
        { text: 'Закрыть', style: 'cancel' },
        {
          text: 'Играть следующим',
          onPress: () => {
            player.playTrack(track, visibleTracks);
            player.next();
          },
        },
        {
          text: 'В плейлист…',
          onPress: () => {
            const create = () => {
              void local.createPlaylist(track.title).then((id) => local.addToPlaylist(id, track.id));
            };
            if (!local.playlists.length) {
              create();
              return;
            }
            Alert.alert('Добавить в плейлист', track.title, [
              { text: 'Отмена', style: 'cancel' },
              ...local.playlists.slice(0, 4).map((item) => ({
                text: item.name,
                onPress: () => void local.addToPlaylist(item.id, track.id),
              })),
              { text: '＋ Новый', onPress: create },
            ]);
          },
        },
        ...(inPlaylist
          ? [
              {
                text: 'Убрать из плейлиста',
                onPress: () => {
                  if (!playlist) return;
                  void local.removeFromPlaylist(playlist.info.id, track.id).then(() => {
                    setPlaylist({ info: playlist.info, tracks: local.tracksOfPlaylist(playlist.info.id) });
                  });
                },
              },
            ]
          : []),
        { text: 'Убрать из библиотеки', style: 'destructive' as const, onPress: () => removeTrack(track) },
      ];
      Alert.alert(track.title, `${track.artist}${track.album ? ` · ${track.album}` : ''}`, buttons);
    },
    [local, player, playlist, removeTrack, visibleTracks]
  );

  const openPlaylist = useCallback(
    (info: Playlist) => {
      setPlaylist({ info, tracks: local.tracksOfPlaylist(info.id) });
    },
    [local]
  );

  /* ---- рендер ---- */
  const header = (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{playlist ? playlist.info.name : 'Моя музыка'}</Text>
          <Text style={styles.headerSub}>
            {playlist
              ? `${playlist.tracks.length} треков · ${formatDuration(playlist.info.duration || 0)}`
              : `${tracks.length} треков · ${formatBytes(local.bytes)}${downloads.count ? ` · офлайн ${downloads.count}` : ''}`}
          </Text>
        </View>

        {playlist ? (
          <Pressable onPress={() => setPlaylist(null)} style={styles.iconButton} accessibilityLabel="Назад">
            <Text style={styles.iconText}>←</Text>
          </Pressable>
        ) : (
          <View style={styles.headerActions}>
            <Pressable
              onPress={() => void importFiles()}
              style={[styles.iconButton, styles.iconButtonAccent]}
              accessibilityLabel="Добавить файлы с телефона"
            >
              <Text style={[styles.iconText, styles.iconTextAccent]}>{importing ? '…' : '＋'}</Text>
            </Pressable>
            <Pressable onPress={() => setSettingsOpen(true)} style={styles.iconButton} accessibilityLabel="Настройки">
              <Text style={styles.iconText}>⚙</Text>
            </Pressable>
          </View>
        )}
      </View>

      {playlist ? (
        <Pressable
          style={styles.primaryButton}
          onPress={() => playlist.tracks.length && player.playTrack(playlist.tracks[0], playlist.tracks)}
        >
          <Text style={styles.primaryButtonText}>Играть</Text>
        </Pressable>
      ) : (
        <>
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Поиск по названию, исполнителю, жанру"
            placeholderTextColor={colors.dim}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />

          <View style={styles.tabs}>
            {(['tracks', 'playlists'] as Tab[]).map((value) => (
              <Pressable
                key={value}
                onPress={() => setTab(value)}
                style={[styles.tab, tab === value && styles.tabActive]}
              >
                <Text style={[styles.tabText, tab === value && styles.tabTextActive]}>
                  {value === 'tracks' ? 'Треки' : `Плейлисты${local.playlists.length ? ` (${local.playlists.length})` : ''}`}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
    </View>
  );

  const empty = (
    <View style={styles.emptyWrap}>
      <Text style={styles.emptyTitle}>Здесь будет ваша музыка</Text>
      <Text style={styles.emptyText}>
        Добавьте файлы с телефона — они сразу появятся в библиотеке и будут играть без интернета.
      </Text>
      <Pressable style={styles.primaryButton} onPress={() => void importFiles()}>
        <Text style={styles.primaryButtonText}>{importing ? 'Открываю…' : '＋ Добавить файлы'}</Text>
      </Pressable>
      <Pressable style={styles.ghostButton} onPress={() => setSourceOpen(true)}>
        <Text style={styles.ghostButtonText}>Другие способы добавить музыку</Text>
      </Pressable>
    </View>
  );

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />

      {playlist || tab === 'tracks' ? (
        <FlatList
          data={visibleTracks}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 120 }}
          renderItem={({ item }) => (
            <TrackRow
              track={item}
              cover={covers[item.id]}
              active={player.current?.id === item.id}
              playing={player.playing}
              downloaded
              onPress={() => player.playTrack(item, visibleTracks)}
              onLongPress={() => trackActions(item)}
              onToggleDownload={() => trackActions(item)}
            />
          )}
          ListEmptyComponent={
            local.ready ? empty : <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
          }
        />
      ) : (
        <FlatList
          data={local.playlists}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 120 }}
          renderItem={({ item }) => (
            <Pressable style={styles.playlistRow} onPress={() => openPlaylist(item)}>
              <View style={styles.playlistIcon}>
                <Text style={styles.playlistIconText}>≡</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={styles.playlistName}>
                  {item.name}
                </Text>
                <Text style={styles.playlistMeta}>
                  {item.trackCount} треков · {formatDuration(item.duration || 0)}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              Плейлистов пока нет. Долгое нажатие на треке → «В плейлист…».
            </Text>
          }
        />
      )}

      <View style={styles.bottom}>
        <MiniPlayer cover={currentCover} onOpen={() => setNowPlayingOpen(true)} />
      </View>

      <NowPlaying
        visible={nowPlayingOpen}
        cover={currentCover}
        onClose={() => setNowPlayingOpen(false)}
        onDownload={() => undefined}
        queueLength={player.queue.length}
        onOpenQueue={() => {
          setNowPlayingOpen(false);
          setTab('tracks');
        }}
      />

      <LinkImportScreen
        visible={linkOpen}
        onClose={() => setLinkOpen(false)}
        onAdd={async ({ url, title }) => {
          const id = await local.addFromLink({ url, title });
          if (!id) throw new Error('Не удалось добавить трек');
        }}
      />

      <LibrarySourceSheet
        visible={sourceOpen}
        onClose={() => setSourceOpen(false)}
        onPickFiles={() => {
          setSourceOpen(false);
          void importFiles();
        }}
        onPickLink={() => {
          setSourceOpen(false);
          setLinkOpen(true);
        }}
        onOpenServer={() => {
          setSourceOpen(false);
          onServerOpen();
        }}
      />

      <SettingsScreen
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLogout={onLogout}
        onOpenServer={onServerOpen}
        onImport={() => {
          setSettingsOpen(false);
          void importFiles();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  headerActions: { flexDirection: 'row', gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerTitle: { color: colors.text, fontSize: 28, fontWeight: '800' },
  headerSub: { color: colors.muted, fontSize: 12.5, marginTop: 3 },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.panel,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonAccent: { backgroundColor: colors.accent },
  iconText: { color: colors.muted, fontSize: 17 },
  iconTextAccent: { color: colors.accentInk, fontSize: 20, fontWeight: '800' },
  search: {
    height: 44,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    marginTop: 14,
    backgroundColor: colors.panel,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabs: { flexDirection: 'row', gap: 8, marginTop: 12 },
  tab: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: colors.panel },
  tabActive: { backgroundColor: colors.accent },
  tabText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: colors.accentInk },
  primaryButton: {
    height: 46,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
    paddingHorizontal: 20,
  },
  primaryButtonText: { color: colors.accentInk, fontWeight: '800', fontSize: 14 },
  ghostButton: { marginTop: 12, paddingVertical: 10, alignItems: 'center' },
  ghostButtonText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  playlistRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  playlistIcon: {
    width: 46,
    height: 46,
    borderRadius: radius.sm,
    backgroundColor: '#1c1c25',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playlistIconText: { color: colors.accentSoft, fontSize: 20, fontWeight: '800' },
  playlistName: { color: colors.text, fontSize: 15, fontWeight: '700' },
  playlistMeta: { color: colors.muted, fontSize: 12.5, marginTop: 2 },
  chevron: { color: colors.dim, fontSize: 20 },
  empty: { color: colors.muted, fontSize: 13.5, textAlign: 'center', marginTop: 40, paddingHorizontal: 32, lineHeight: 20 },
  emptyWrap: { paddingHorizontal: 28, paddingTop: 24, alignItems: 'stretch' },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  emptyText: { color: colors.muted, fontSize: 13.5, textAlign: 'center', lineHeight: 20, marginTop: 8 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
