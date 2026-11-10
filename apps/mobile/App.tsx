import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Audio, type AVPlaybackStatus } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, formatDuration, type Track } from '@vision/shared';

/**
 * Мобильный клиент (Android + iOS). MVP-экран: вход → библиотека → плеер.
 * Адрес API задаётся EXPO_PUBLIC_API_URL (по умолчанию Android-эмулятор → хост).
 */
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:4000';
const TOKEN_KEY = 'vision.token';

const client = createClient({ baseUrl: API_URL });

export default function App() {
  const [status, setStatus] = useState<'loading' | 'anon' | 'authed'>('loading');

  useEffect(() => {
    (async () => {
      const token = await AsyncStorage.getItem(TOKEN_KEY);
      if (!token) return setStatus('anon');
      client.setToken(token);
      try {
        await client.me();
        setStatus('authed');
      } catch {
        await AsyncStorage.removeItem(TOKEN_KEY);
        setStatus('anon');
      }
    })();
  }, []);

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#ff5a1f" />
      </View>
    );
  }

  return status === 'anon' ? <LoginScreen onDone={() => setStatus('authed')} /> : <LibraryScreen />;
}

function LoginScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token } = await client.login(password);
      client.setToken(token);
      await AsyncStorage.setItem(TOKEN_KEY, token);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось войти');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.loginCard}>
        <Text style={styles.logo}>VISION</Text>
        <Text style={styles.title}>Ваша музыка.{'\n'}Только ваша.</Text>
        <TextInput
          style={styles.input}
          placeholder="Пароль"
          placeholderTextColor="#6f6f80"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={submit}
        />
        {error && <Text style={styles.error}>{error}</Text>}
        <Pressable style={[styles.button, busy && styles.buttonDisabled]} onPress={submit} disabled={busy || !password}>
          <Text style={styles.buttonText}>{busy ? 'Проверяем…' : 'Войти'}</Text>
        </Pressable>
        <Text style={styles.hint}>Сервер: {API_URL}</Text>
      </View>
    </SafeAreaView>
  );
}

function LibraryScreen() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [current, setCurrent] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(true);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    client.tracks().then(setTracks).finally(() => setLoading(false));
    return () => {
      soundRef.current?.unloadAsync();
    };
  }, []);

  const open = useCallback(async (track: Track) => {
    await soundRef.current?.unloadAsync();
    // ссылки подписанные и короткоживущие — запрашиваем свежую перед стартом
    const media = await client.media([track.id]).catch(() => null);
    const uri = media?.items[track.id]?.stream;
    if (!uri) return;
    const { sound } = await Audio.Sound.createAsync(
      { uri },
      { shouldPlay: true },
      (status: AVPlaybackStatus) => {
        if (!status.isLoaded) return;
        setPlaying(status.isPlaying);
        setPosition((status.positionMillis ?? 0) / 1000);
        setDuration((status.durationMillis ?? 0) / 1000);
      }
    );
    soundRef.current = sound;
    setCurrent(track);
    client.registerPlay(track.id).catch(() => {});
  }, []);

  const toggle = async () => {
    if (!soundRef.current) return;
    const status = await soundRef.current.getStatusAsync();
    if (!status.isLoaded) return;
    await (status.isPlaying ? soundRef.current.pauseAsync() : soundRef.current.playAsync());
  };

  const seekBy = async (delta: number) => {
    if (!soundRef.current) return;
    const status = await soundRef.current.getStatusAsync();
    if (!status.isLoaded) return;
    await soundRef.current.setPositionAsync(Math.max(0, (status.positionMillis ?? 0) + delta * 1000));
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Библиотека</Text>
        <Text style={styles.headerSub}>{tracks.length} треков</Text>
      </View>

      {loading ? (
        <ActivityIndicator color="#ff5a1f" style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: current ? 120 : 24 }}
          renderItem={({ item }) => (
            <Pressable style={[styles.row, current?.id === item.id && styles.rowActive]} onPress={() => open(item)}>
              <View style={styles.art}>
                <Text style={styles.artLetter}>{item.title.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[styles.rowTitle, current?.id === item.id && { color: '#ff8a3d' }]}>
                  {item.title}
                </Text>
                <Text numberOfLines={1} style={styles.rowArtist}>{item.artist}</Text>
              </View>
              <Text style={styles.rowTime}>{formatDuration(item.duration)}</Text>
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={styles.hint}>Библиотека пуста — загрузите треки через веб-версию.</Text>
          }
        />
      )}

      {current && (
        <View style={styles.player}>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={styles.playerTitle}>{current.title}</Text>
            <Text numberOfLines={1} style={styles.playerArtist}>{current.artist}</Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${duration ? (position / duration) * 100 : 0}%` }]} />
            </View>
            <Text style={styles.hint}>
              {formatDuration(position)} / {formatDuration(duration || current.duration)}
            </Text>
          </View>
          <View style={styles.controls}>
            <Pressable onPress={() => seekBy(-15)} style={styles.control}>
              <Text style={styles.controlText}>−15</Text>
            </Pressable>
            <Pressable onPress={toggle} style={styles.playButton}>
              <Text style={styles.playText}>{playing ? '❚❚' : '▶'}</Text>
            </Pressable>
            <Pressable onPress={() => seekBy(15)} style={styles.control}>
              <Text style={styles.controlText}>+15</Text>
            </Pressable>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#07070a' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#07070a' },
  loginCard: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, gap: 14 },
  logo: { color: '#ff5a1f', fontWeight: '800', letterSpacing: 4 },
  title: { color: '#f4f4f8', fontSize: 30, fontWeight: '800', lineHeight: 34, marginBottom: 18 },
  input: {
    height: 50, borderRadius: 12, paddingHorizontal: 16,
    backgroundColor: '#15151c', color: '#fff', borderWidth: 1, borderColor: '#26262f',
  },
  button: { height: 50, borderRadius: 12, backgroundColor: '#ff5a1f', alignItems: 'center', justifyContent: 'center' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#180c05', fontWeight: '700', fontSize: 15 },
  error: { color: '#ff8a8a', fontSize: 13 },
  hint: { color: '#6f6f80', fontSize: 12 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16 },
  headerTitle: { color: '#f4f4f8', fontSize: 30, fontWeight: '800' },
  headerSub: { color: '#9a9aab', fontSize: 13, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 10 },
  rowActive: { backgroundColor: 'rgba(255,90,31,0.10)' },
  art: {
    width: 46, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#2a1a12',
  },
  artLetter: { color: '#ff8a3d', fontWeight: '800', fontSize: 18 },
  rowTitle: { color: '#f4f4f8', fontSize: 15, fontWeight: '600' },
  rowArtist: { color: '#9a9aab', fontSize: 12.5, marginTop: 2 },
  rowTime: { color: '#6f6f80', fontSize: 12 },
  player: {
    position: 'absolute', left: 12, right: 12, bottom: 16, flexDirection: 'row', alignItems: 'center', gap: 14,
    padding: 14, borderRadius: 18, backgroundColor: '#14141b', borderWidth: 1, borderColor: '#26262f',
  },
  playerTitle: { color: '#f4f4f8', fontSize: 14, fontWeight: '700' },
  playerArtist: { color: '#9a9aab', fontSize: 12, marginTop: 2 },
  progressTrack: { height: 4, borderRadius: 4, backgroundColor: '#2a2a34', marginTop: 10, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: '#ff5a1f' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  control: { paddingHorizontal: 8, paddingVertical: 8 },
  controlText: { color: '#9a9aab', fontSize: 12, fontWeight: '600' },
  playButton: {
    width: 46, height: 46, borderRadius: 23, backgroundColor: '#ff5a1f',
    alignItems: 'center', justifyContent: 'center',
  },
  playText: { color: '#180c05', fontSize: 16, fontWeight: '800' },
});
