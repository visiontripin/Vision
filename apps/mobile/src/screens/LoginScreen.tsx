import { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, setApiBase } from '../api';
import { KEYS, defaultBase, normalizeBase, saveBase } from '../config';
import { colors, radius } from '../theme';

/**
 * Вход: адрес домашнего сервера + пароль. Адрес не зашит в сборку, потому что
 * у каждого он свой (Wi-Fi дома, Tailscale, туннель Cloudflare).
 */
export function LoginScreen({ initialBase, onDone }: { initialBase: string; onDone: () => void }) {
  const [base, setBase] = useState(initialBase || defaultBase());
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const normalized = normalizeBase(base);
    if (!normalized) {
      setError('Укажите адрес сервера, например http://192.168.1.10:4000');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setApiBase(normalized);
      const { token } = await api.login(password);
      api.setToken(token);
      await saveBase(normalized);
      await AsyncStorage.setItem(KEYS.token, token);
      onDone();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Не удалось войти';
      setError(message === 'Unauthorized' || message.includes('unauthorized') ? 'Неверный пароль' : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.logo}>VISION</Text>
          <Text style={styles.title}>Ваша музыка.{'\n'}Только ваша.</Text>

          <Text style={styles.label}>Адрес сервера</Text>
          <TextInput
            style={styles.input}
            value={base}
            onChangeText={setBase}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://192.168.1.10:4000"
            placeholderTextColor={colors.dim}
          />
          <Text style={styles.hint}>
            Домашний сервер в той же Wi-Fi или адрес Tailscale. Порт по умолчанию — 4000.
          </Text>

          <Text style={styles.label}>Пароль</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Пароль"
            placeholderTextColor={colors.dim}
            onSubmitEditing={submit}
            returnKeyType="go"
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={[styles.button, (busy || !password) && styles.buttonDisabled]}
            onPress={submit}
            disabled={busy || !password}
          >
            {busy ? <ActivityIndicator color={colors.accentInk} /> : <Text style={styles.buttonText}>Войти</Text>}
          </Pressable>

          <Text style={styles.hint}>
            Сервер: {normalizeBase(base) || '—'}{'\n'}
            Адрес можно поменять позже в настройках.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32, gap: 8 },
  logo: { color: colors.accent, fontWeight: '800', letterSpacing: 4, marginBottom: 4 },
  title: { color: colors.text, fontSize: 30, fontWeight: '800', lineHeight: 34, marginBottom: 20 },
  label: { color: colors.muted, fontSize: 12, marginTop: 10, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 },
  input: {
    height: 50,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    backgroundColor: colors.panel,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  hint: { color: colors.dim, fontSize: 12, lineHeight: 17, marginTop: 6 },
  error: { color: colors.danger, fontSize: 13, marginTop: 10 },
  button: {
    height: 50,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 18,
  },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: colors.accentInk, fontWeight: '800', fontSize: 15 },
});
