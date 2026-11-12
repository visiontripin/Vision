import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { api, apiBase, initApi } from './src/api';
import { installCrashReporter } from './src/crash';
import { KEYS, loadBase, saveBase } from './src/config';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DownloadsProvider } from './src/downloads';
import { LocalLibraryProvider } from './src/local';
import { SyncProvider } from './src/sync';
import { PlayerProvider, usePlayer } from './src/player';
import { DeepLinkHandler } from './src/components/DeepLinkHandler';
import { useLibrary } from './src/useLibrary';
import { MainScreen } from './src/screens/MainScreen';
import { ServerScreen } from './src/screens/ServerScreen';
import { colors } from './src/theme';

/**
 * Версия приложения для отчётов о падениях: одна строка, чтобы в панели было
 * видно, какая сборка падает.
 */
const APP_VERSION = '0.8.0';

/**
 * Vision Audio — мобильный плеер (Android + iOS).
 *
 * Запуск больше не начинается с адреса сервера: музыка на телефоне — первый и
 * основной источник, библиотека открывается сразу. Подключение к домашнему
 * серверу — необязательный экран, который открывается из «Добавить музыку» или
 * настроек.
 *
 * Порядок: локальная библиотека → плеер → библиотека на экране. Сохранённый
 * адрес сервера проверяется в фоне и, если сервер отвечает, ничего не меняет на
 * экране — он просто доступен как второй источник.
 */
export default function App() {
  const [booting, setBooting] = useState(true);
  const [serverOpen, setServerOpen] = useState(false);

  /* Отчёты о падениях ставятся до всего остального: падение при запуске — самое
     обидное, человек видит только закрывшееся приложение. */
  useEffect(() => {
    installCrashReporter({ getBaseUrl: apiBase, version: APP_VERSION });
  }, []);

  useEffect(() => {
    (async () => {
      const base = await initApi();
      void base;
      const token = await AsyncStorage.getItem(KEYS.token).catch(() => null);
      if (token) {
        api.setToken(token);
        // Сервер может быть выключен — это нормально, приложение работает без него.
        void api.me().catch(() => undefined);
      }
    })().finally(() => setBooting(false));
  }, []);

  const onServerConnected = useCallback(async () => {
    await saveBase(api.baseUrl);
    setServerOpen(false);
  }, []);

  if (booting) {
    return (
      <View style={styles.center}>
        <StatusBar style="light" />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <LocalLibraryProvider>
      <SyncProvider>
        <DownloadsProvider>
          <PlayerProvider>
            <DeepLinks />
            <MainScreen />
          </PlayerProvider>
        </DownloadsProvider>
      </SyncProvider>
    </LocalLibraryProvider>
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
