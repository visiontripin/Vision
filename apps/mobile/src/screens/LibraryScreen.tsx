import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, SafeAreaView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { formatDuration, type Playlist, type Track } from '@vision/shared';
import { api } from '../api';
import { useCovers } from '../useCovers';
import { filterTracks, useLibrary } from '../useLibrary';
import { useDownloads } from '../downloads';
import { usePlayer } from '../player';
import { pickDownloadSource } from '../lib/media';
import { formatBytes } from '../lib/format';
import { colors, radius } from '../theme';
import { TrackRow } from '../components/TrackRow';
import { MiniPlayer } from '../components/MiniPlayer';
import { NowPlaying } from './NowPlaying';
import { SettingsScreen } from './SettingsScreen';

type Tab = 'tracks' | 'playlists';

/**
 * Главный экран: библиотека, поиск, плейлисты, мини-плеер.
 * Данные тянем с домашнего сервера, скачанные треки играют из локальных файлов.
 */
export function LibraryScreen({ onLogout }: { onLogout: () => void }) {
  const { tracks, playlists, loading, error, reload } = useLibrary();
  const downloads = useDownloads();
  const player = usePlayer();

  const [tab, setTab] = useState<Tab>('tracks');
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [playlist, setPlaylist] = useState<{ info: Playlist; tracks: Track[] } | null>(null);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const visibleTracks = useMemo(() => (playlist ? playlist.tracks : filterTracks(tracks, query)), [tracks, query, playlist]);
  const covers = useCovers(visibleTracks.map((track) => track.id));

  const currentCover = player.current ? covers[player.current.id] : undefined;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  /* ---- скачивание ---- */
  const downloadTrack = useCallback(
    async (track: Track) => {
      try {
        const media = await api.media([track.id]);
        const item = media.items[track.id];
        const source = pickDownloadSource(item?.streams, track.mime, item?.stream);
        if (!source) throw new Error('Сервер не выдал ссылку на файл');
        await downloads.download(track, source.url, source.mime);
      } catch (cause) {
        Alert.alert('Не удалось скачать', cause instanceof Error ? cause.message : 'Попробуйте ещё раз');
      }
    },
    [downloads]
  );

  const toggleDownload = useCallback(
    (track: Track) => {
      if (downloads.has(track.checksum ?? track.id)) {
        Alert.alert('Удалить офлайн-копию?', `${track.title} — ${track.artist}`, [
          { text: 'Отмена', style: 'cancel' },
          { text: 'Удалить', style: 'destructive', onPress: () => void downloads.remove(track.checksum ?? track.id) },
        ]);
        return;
      }
      void downloadTrack(track);
    },
    [downloads, downloadTrack]
  );

  const downloadPlaylist = useCallback(async () => {
    if (!playlist) return;
    const list = playlist.tracks;
    const media = await api.media(list.map((track) => track.id)).catch(() => null);
    const items = list
      .map((track) => {
        const source = pickDownloadSource(media?.items[track.id]?.streams, track.mime, media?.items[track.id]?.stream);
        return source ? { track, url: source.url, mime: source.mime } : null;
      })
      .filter((item): item is { track: Track; url: string; mime: string } => Boolean(item));

    if (!items.length) {
      Alert.alert('Нечего скачивать', 'Сервер не выдал ссылки на файлы.');
      return;
    }

    setBatch({ done: 0, total: items.length });
    try {
      await downloads.downloadMany(items, (done, total) => setBatch({ done, total }));
    } finally {
      setBatch(null);
    }
  }, [playlist, downloads]);

  const openPlaylist = useCallback(async (info: Playlist) => {
    try {
      const playlistTracks = await api.playlistTracks(info.id);
      setPlaylist({ info, tracks: playlistTracks });
    } catch (cause) {
      Alert.alert('Не удалось открыть плейлист', cause instanceof Error ? cause.message : '');
    }
  }, []);

  /* ---- рендер ---- */
  const header = (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{playlist ? playlist.info.name : 'Библиотека'}</Text>
          <Text style={styles.headerSub}>
            {playlist
              ? `${playlist.tracks.length} треков · ${formatDuration(playlist.info.duration || 0)}`
              : `${tracks.length} треков · офлайн ${downloads.count} (${formatBytes(downloads.totalBytes)})`}
          </Text>
        </View>

        {playlist ? (
          <Pressable onPress={() => setPlaylist(null)} style={styles.iconButton} accessibilityLabel="Назад">
            <Text style={styles.iconText}>←</Text>
          </Pressable>
        ) : (
          <Pressable onPress={() => setSettingsOpen(true)} style={styles.iconButton} accessibilityLabel="Настройки">
            <Text style={styles.iconText}>⚙</Text>
          </Pressable>
        )}
      </View>

      {playlist ? (
        <View style={styles.playlistActions}>
          <Pressable
            style={styles.primaryButton}
            onPress={() => playlist.tracks.length && player.playTrack(playlist.tracks[0], playlist.tracks)}
          >
            <Text style={styles.primaryButtonText}>Играть</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={() => void downloadPlaylist()} disabled={Boolean(batch)}>
            <Text style={styles.secondaryButtonText}>
              {batch ? `Скачиваю ${batch.done}/${batch.total}` : 'Скачать плейлист'}
            </Text>
          </Pressable>
        </View>
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
                  {value === 'tracks' ? 'Треки' : `Плейлисты${playlists.length ? ` (${playlists.length})` : ''}`}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
          renderItem={({ item }) => {
            const progress = downloads.progress[item.id];
            return (
              <TrackRow
                track={item}
                cover={covers[item.id]}
                active={player.current?.id === item.id}
                playing={player.playing}
                downloaded={downloads.has(item.checksum ?? item.id)}
                progress={progress}
                onPress={() => {
                  if (item.available === false && !downloads.has(item.checksum ?? item.id)) {
                    Alert.alert(
                      'Нет источника',
                      'Ни одно устройство сейчас не раздаёт этот файл. Включите Termux или ПК с копией и обновите библиотеку.'
                    );
                    return;
                  }
                  player.playTrack(item, visibleTracks);
                }}
                onLongPress={() =>
                  Alert.alert(item.title, `${item.artist}${item.genre ? ` · ${item.genre}` : ''}`, [
                    { text: 'Закрыть', style: 'cancel' },
                    {
                      text: downloads.has(item.checksum ?? item.id) ? 'Удалить копию' : 'Скачать офлайн',
                      onPress: () => toggleDownload(item),
                    },
                  ])
                }
                onToggleDownload={() => toggleDownload(item)}
              />
            );
          }}
          ListEmptyComponent={
            loading ? (
              <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
            ) : (
              <Text style={styles.empty}>
                {error ?? 'Библиотека пуста — загрузите треки через веб-версию.'}
              </Text>
            )
          }
        />
      ) : (
        <FlatList
          data={playlists}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 120 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
          renderItem={({ item }) => (
            <Pressable style={styles.playlistRow} onPress={() => void openPlaylist(item)}>
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
              {loading ? 'Загружаем…' : 'Плейлистов пока нет — создайте их в веб-версии.'}
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
        onDownload={() => player.current && toggleDownload(player.current)}
        queueLength={player.queue.length}
        onOpenQueue={() => {
          setNowPlayingOpen(false);
          setTab('tracks');
        }}
      />

      <SettingsScreen
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLogout={onLogout}
        onReload={reload}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
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
  iconText: { color: colors.muted, fontSize: 17 },
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
  playlistActions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  primaryButton: {
    flex: 1,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { color: colors.accentInk, fontWeight: '800', fontSize: 14 },
  secondaryButton: {
    flex: 1,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { color: colors.text, fontWeight: '600', fontSize: 13 },
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
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
