# Vision Audio — Android и iOS

React Native (Expo) + общий клиент `@vision/shared`. Это отдельный проект: не входит
в npm workspaces корня, чтобы не тянуть 400 МБ зависимостей при обычной сборке веба.

## Запуск на устройстве/эмуляторе

```bash
cd apps/mobile
npm install
npx expo install --fix        # выравнивает версии под вашу версию Expo SDK
```

Адрес API задаётся переменной окружения:

```bash
# Android-эмулятор видит хост как 10.0.2.2
EXPO_PUBLIC_API_URL=http://10.0.2.2:4000 npm run android

# iOS-симулятор — localhost
EXPO_PUBLIC_API_URL=http://localhost:4000 npm run ios

# Реальный телефон — IP машины в локальной сети
EXPO_PUBLIC_API_URL=http://192.168.1.10:4000 npx expo start
```

В `app.json` уже включены: фоновое аудио на iOS (`UIBackgroundModes: audio`) и
media-playback foreground service на Android.

## Сборки

```bash
npm i -g eas-cli && eas login
eas build:configure
npm run build:android   # AAB для Google Play
npm run build:ios       # IPA для App Store / TestFlight
```

Перед публикацией: подставить реальный `bundleIdentifier`/`package`,
настроить `eas.json` (production-профиль), загрузить иконку 1024×1024 и splash.

## Что уже реализовано

- вход по паролю с сохранением токена в AsyncStorage;
- список треков с обложками-заглушками и длительностью;
- стриминг через Range-запросы, пауза/продолжение, seek ±15 с;
- счётчик прослушиваний.

## Дальше по плану (этап 2 из docs/ROADMAP.md)

- `react-native-track-player` вместо `expo-av`: фоновое воспроизведение, экран блокировки, Bluetooth;
- офлайн-кэш (`expo-file-system`) и предзагрузка плейлистов;
- загрузка файлов из «Файлов»/«Музыки» (`expo-document-picker`);
- очередь, shuffle, лайки, плейлисты;
- медиа-уведомления и Android Auto / CarPlay (этап 4).
