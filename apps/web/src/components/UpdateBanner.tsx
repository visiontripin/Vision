import { useCallback, useEffect, useState } from 'react';
import { isDesktop } from '../desktop';
import {
  UPDATE_INTERVAL_MS, isSnoozed, parseManifest, snoozeUpdate, updateLabel, type UpdateCandidate,
} from '../updates';
import { Icon } from '../ui';

/**
 * Плашка «Доступна версия X» для десктопного приложения (I4).
 *
 * Требования, которые определили вид:
 *  - **не мешать**: полоса внизу, не модалка; музыка продолжает играть;
 *  - **ничего молча**: скачивание и установка — по кнопке, перезапуск предлагается
 *    после установки, а не вместо неё;
 *  - **«Позже» — на сутки** и только для этой версии (см. `isSnoozed`);
 *  - в браузере и PWA компонент не делает ничего: там обновление — это перезагрузка
 *    страницы, и притворяться нативным апдейтом нельзя.
 *
 * Источник данных — команда Rust `updater_check`: она спрашивает манифест и
 * возвращает версию с заметками. `parseManifest` используется в тестах и при
 * проверке манифеста до публикации; в рантайме разбор делает Tauri (он же
 * проверяет подпись).
 */
export function UpdateBanner() {
  const [candidate, setCandidate] = useState<UpdateCandidate | null>(null);
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState<'check' | 'install' | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!isDesktop()) return;
    setBusy('check');
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const info = await invoke<{
        available: boolean;
        version: string | null;
        notes: string | null;
        current: string;
      }>('updater_check');
      setCurrent(info.current);
      if (!info.available || !info.version) {
        setCandidate(null);
        return;
      }
      if (isSnoozed(info.version)) return;
      setCandidate({
        version: info.version,
        notes: info.notes,
        publishedAt: null,
        // адрес и подпись проверяет Tauri; интерфейсу они не нужны
        url: '',
        signature: '',
      });
    } catch (e) {
      // «проверить не удалось» ≠ «обновлений нет»: молчим, но не пугаем
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (!isDesktop()) return;
    void check();
    const timer = window.setInterval(() => void check(), UPDATE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [check]);

  const install = async () => {
    setBusy('install');
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const version = await invoke<string>('updater_install');
      setInstalled(version);
      setCandidate(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const later = () => {
    if (candidate) snoozeUpdate(candidate.version);
    setCandidate(null);
  };

  if (installed) {
    return (
      <div className="update-bar" role="status">
        <Icon name="disc" size={16} />
        <span>Версия {installed} установлена — перезапустите приложение, чтобы применить.</span>
        <button type="button" className="btn btn--small btn--ghost" onClick={() => setInstalled(null)}>
          Понятно
        </button>
      </div>
    );
  }

  if (!candidate) return null;

  return (
    <div className="update-bar" role="status">
      <Icon name="disc" size={16} />
      <div className="update-bar__text">
        <strong>{updateLabel(candidate, current)}</strong>
        {candidate.notes && <span>{candidate.notes.split('\n')[0]}</span>}
        {error && <span className="error">{error}</span>}
      </div>
      <button
        type="button"
        className="btn btn--small btn--primary"
        disabled={busy === 'install'}
        onClick={() => void install()}
      >
        {busy === 'install' ? 'Устанавливаю…' : 'Скачать и установить'}
      </button>
      <button type="button" className="btn btn--small btn--ghost" onClick={later}>
        Позже
      </button>
    </div>
  );
}

/** Для тестов и ручной проверки манифеста до публикации. */
export { parseManifest };
