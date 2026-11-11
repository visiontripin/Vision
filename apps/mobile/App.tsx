import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, apiBase, initApi } from './src/api';
import { installCrashReporter } from './src/crash';
import { KEYS, loadBase, saveBase } from './src/config';
import { DownloadsProvider } from './src/downloads';
import { PlayerProvider, usePlayer } from './src/player';
import { DeepLinkHandler } from './src/components/DeepLinkHandler';
import { useLibrary } from './src/useLibrary';
import { LoginScreen } from './src/screens/LoginScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { colors } from './src/theme';

/**
 * Версия приложения для отчётов о падениях: одна строка, чтобы в панели было
 * видно, какая сборка падает.
 */
const APP_VERSION = '0.6.0';

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

  /*
   * Отчёты о падениях ставятся до всего остального: падение при запуске (до
   * входа, до загрузки библиотеки) — самое обидное, потому что человек видит
   * только закрывшееся приложение. Ошибки внутри самого репортера гасятся.
   */
  useEffect(() => {
    installCrashReporter({ getBaseUrl: apiBase, version: APP_VERSION });
  }, []);

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
          <>
            <DeepLinks />
            <LibraryScreen onLogout={() => void logout()} />
          </>
        )}
      </PlayerProvider>
    </DownloadsProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
});

/**
 * Ссылки из других приложений приходят в уже открытое приложение или запускают
 * его «холодным». Обработчик живёт рядом с библиотекой, потому что для перехода
 * нужен список треков, а он грузится внутри экрана.
 */
function DeepLinks() {
  const { tracks } = useLibrary();
  const player = usePlayer();
  return <DeepLinkHandler tracks={tracks} player={player} />;
}
