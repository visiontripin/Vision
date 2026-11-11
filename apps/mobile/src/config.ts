import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Адрес сервера и токен хранятся на устройстве: приложение подключается к
 * домашнему серверу (Termux/ПК) по Wi-Fi или через Tailscale, поэтому адрес
 * нельзя зашить в сборку — его вводит пользователь на экране входа.
 */

export const KEYS = {
  base: 'vision.apiBase',
  token: 'vision.token',
} as const;

/** Умолчание для разработки: Android-эмулятор видит хост как 10.0.2.2. */
const DEV_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:4000';

/** Приводит ввод к виду `http://host:port` без хвостового слэша. */
export function normalizeBase(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  return withScheme.replace(/\/+$/, '');
}

export function defaultBase(): string {
  return normalizeBase(DEV_BASE);
}

export async function loadBase(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(KEYS.base);
    if (stored) return normalizeBase(stored);
  } catch {
    /* приватное хранилище недоступно — работаем на умолчании */
  }
  return defaultBase();
}

export async function saveBase(base: string): Promise<string> {
  const value = normalizeBase(base);
  try {
    await AsyncStorage.setItem(KEYS.base, value);
  } catch {
    /* noop */
  }
  return value;
}

/** Токен владельца: в приложении он живёт в защищённом хранилище ОС. */
export async function loadToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEYS.token);
  } catch {
    return null;
  }
}
