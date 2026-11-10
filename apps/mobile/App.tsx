import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, initApi } from './src/api';
import { KEYS, loadBase, saveBase } from './src/config';
import { DownloadsProvider } from './src/downloads';
import { PlayerProvider } from './src/player';
import { LoginScreen } from './src/screens/LoginScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { colors } from './src/theme';

/**
 * Vision Audio — мобильный клиент (Android + iOS).
 *
 * Порядок запуска: адрес сервера из хранилища → проверка сохранённого токена →
 * вход или библиотека. Дальше всё живёт в двух провайдерах: скачанные треки
 * (локальные файлы) и плеер (expo-av + очередь).
 */
export default function App() {
  const [phase, setPhase] = useState<'boot' | 'anon' | 'ready'>('boot');
  const [base, setBase] = useState('');

  useEffect(() => {
    (async () => {
      const loadedBase = await initApi();
      setBase(loadedBase);

      const token = await AsyncStorage.getItem(KEYS.token).catch(() => null);
      if (!token) {
        setPhase('anon');
        return;
      }

      api.setToken(token);
      try {
        await api.me();
        setPhase('ready');
      } catch {
        // сервер недоступен или токен истёк — показываем вход, токен не трогаем:
        // он ещё пригодится, когда телефон вернётся в домашнюю сеть
        setPhase('anon');
      }
    })();
  }, []);

  const onLoggedIn = useCallback(async () => {
    setBase(await loadBase());
    setPhase('ready');
  }, []);

  const logout = useCallback(async () => {
    await saveBase(api.baseUrl);
    setPhase('anon');
  }, []);

  if (phase === 'boot') {
    return (
      <View style={styles.center}>
        <StatusBar style="light" />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <DownloadsProvider>
      <PlayerProvider>
        {phase === 'anon' ? (
          <LoginScreen initialBase={base} onDone={() => void onLoggedIn()} />
        ) : (
          <LibraryScreen onLogout={() => void logout()} />
        )}
      </PlayerProvider>
    </DownloadsProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
});
