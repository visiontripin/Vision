/**
 * Персональные подборки по истории (Фаза 5, J3).
 *
 * Задача: не «рекомендации как у Spotify» (для этого нужны чужие вкусы и
 * эмбеддинги), а честный ответ на вопрос «что включить сейчас» из того, что уже
 * есть: недавно слушал, любимые жанры, что забросил.
 *
 * Правила подбора живут здесь и проверяются на «сухих» данных:
 *  - **черновик уже слышанного не предлагаем** — «Продолжить слушать» для этого;
 *  - **недавно прослушанное не повторяем** в «Любимом жанре» (окно 3 дня);
 *  - **порядок детерминированный**, если передан `seed`: подборка не должна
 *    перетасовываться при каждом открытии страницы, но должна меняться раз в день;
 *  - **пустая история — не ошибка**: возвращаем пустой список и причину, интерфейс
 *    скажет «включите что-нибудь, и подборки появятся»;
 *  - **один трек — одна причина**: свежая загрузка не попадает в «забытое», а
 *    недавно прослушанное — в «любимый жанр».
 *
 * Всё считается из библиотеки (до 2000 треков), поэтому подборки работают и на
 * домашнем сервере без интернета и без внешних сервисов.
 */

/**
 * Формы данных (JSDoc, а не TypeScript: сервер — plain ESM без сборки).
 *
 * @typedef {object} PersonalTrack
 * @property {string} id
 * @property {string} title
 * @property {string} artist
 * @property {string|null} [genre]
 * @property {number} [duration]
 * @property {number} [plays]
 * @property {boolean} [liked]
 * @property {string|null} [addedAt]     когда добавлен (ISO)
 * @property {string|null} [listenedAt]  когда слушали в последний раз (ISO) или null
 * @property {number|null} [progress]    незаконченное прослушивание 0…1
 *
 * @typedef {object} PersonalSection
 * @property {'continue'|'top-genre'|'forgotten'|'fresh'|'liked-mix'} key
 * @property {string} title
 * @property {string} reason  почему именно это — одной строкой
 * @property {PersonalTrack[]} tracks
 */

export const SECTION_LIMIT = 12;
/** «Недавно слушал» — окно, внутри которого трек не повторяем в других подборках. */
export const RECENT_DAYS = 3;
/** «Забытые» — не слушали столько дней (или никогда). */
export const FORGOTTEN_DAYS = 30;
/** «Новинки» — добавлены за последние дни. */
export const FRESH_DAYS = 14;

const DAY_MS = 86_400_000;

const time = (value) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const daysSince = (value, now) => {
  const at = time(value);
  if (at === null) return null;
  return Math.max(0, (now - at) / DAY_MS);
};

/** Детерминированный порядок: одинаковый для всех при том же дне. */
function shuffle(items, seed) {
  const copy = [...items];
  let state = seed || 1;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    // xorshift32 — короткий и воспроизводимый, криптостойкость не нужна
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = Math.abs(state) % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Номер дня — «seed по умолчанию»: подборка меняется раз в сутки. */
export const daySeed = (now = Date.now()) => Math.floor(now / DAY_MS);

/**
 * Собирает подборки. `now` и `seed` — параметры, а не `Date.now()` внутри, чтобы
 * результат был воспроизводим в тестах.
 */
export function buildSections(tracks, { now = Date.now(), seed = daySeed(now), limit = SECTION_LIMIT } = {}) {
  /** @type {PersonalSection[]} */
  const sections = [];
  const valid = tracks.filter((track) => track && track.id);

  /* --- продолжить слушать: начатое, но не законченное --- */
  const continueTracks = valid
    .filter((track) => {
      const progress = Number(track.progress ?? 0);
      return track.listenedAt && progress > 0.05 && progress < 0.95;
    })
    .sort((a, b) => (time(b.listenedAt) ?? 0) - (time(a.listenedAt) ?? 0))
    .slice(0, limit);
  if (continueTracks.length) {
    sections.push({
      key: 'continue',
      title: 'Продолжить слушать',
      reason: 'вы остановились на середине',
      tracks: continueTracks,
    });
  }

  /* --- любимый жанр: что чаще слушаете, но не вчера --- */
  /**
   * Вес жанра — не «сколько треков», а «сколько внимания»: прослушивания,
   * лайк (сильный сигнал) и сам факт, что трек когда-то включали. Иначе у
   * человека, который слушает с телефона без `plays`, жанр не находился бы.
   */
  const genreWeight = new Map();
  for (const track of valid) {
    const genre = String(track.genre ?? '').trim();
    if (!genre) continue;
    const plays = Math.max(0, Number(track.plays ?? 0));
    const signal = plays + (track.liked ? 4 : 0) + (track.listenedAt ? 2 : 0);
    const entry = genreWeight.get(genre) ?? { weight: 0, count: 0 };
    entry.weight += signal;
    entry.count += 1;
    genreWeight.set(genre, entry);
  }

  const genresByWeight = [...genreWeight.entries()]
    .filter(([, entry]) => entry.weight > 0)
    .sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]));

  for (const [genre] of genresByWeight) {
    // Свежепрослушанное — в конец, но не выкидываем: иначе у человека, который
    // слушал весь свой эмбиент вчера, подборка просто исчезнет.
    const wasRecent = (track) => {
      const days = daysSince(track.listenedAt, now);
      return days !== null && days < RECENT_DAYS ? 1 : 0;
    };
    const candidates = valid
      .filter((track) => String(track.genre ?? '').trim() === genre)
      .sort((a, b) => wasRecent(a) - wasRecent(b)
        || Number(b.liked ?? false) - Number(a.liked ?? false)
        || Number(b.plays ?? 0) - Number(a.plays ?? 0));
    if (!candidates.length) continue; // всё слушали вчера — берём следующий жанр
    sections.push({
      key: 'top-genre',
      title: `Любимый жанр: ${genre}`,
      reason: 'чаще всего слушаете, но не в последние дни',
      tracks: candidates.slice(0, limit),
    });
    break;
  }

  /* --- забытое: давно не слушали (или никогда), но это уже в библиотеке --- */
  const forgotten = valid
    .filter((track) => {
      const days = daysSince(track.listenedAt, now);
      if (days !== null && days < FORGOTTEN_DAYS) return false;
      // Свежая загрузка — это «новое», а не «забытое»: иначе один и тот же трек
      // объяснялся бы двумя противоположными причинами.
      const age = daysSince(track.addedAt, now);
      return age === null || age > FRESH_DAYS;
    })
    // «Никогда не слушал» — сильнее забытое, чем «слушал год назад»
    .sort((a, b) => Number(time(a.listenedAt) ?? 0) - Number(time(b.listenedAt) ?? 0))
    .slice(0, limit);
  if (forgotten.length) {
    sections.push({
      key: 'forgotten',
      title: 'Забытое',
      reason: `не слушали ${FORGOTTEN_DAYS}+ дней или ни разу`,
      tracks: forgotten,
    });
  }

  /* --- новинки: свежая библиотека, ещё без истории --- */
  const fresh = valid
    .filter((track) => {
      const days = daysSince(track.addedAt, now);
      return days !== null && days <= FRESH_DAYS;
    })
    .sort((a, b) => (time(b.addedAt) ?? 0) - (time(a.addedAt) ?? 0))
    .slice(0, limit);
  if (fresh.length) {
    sections.push({
      key: 'fresh',
      title: 'Новое в библиотеке',
      reason: `добавлено за последние ${FRESH_DAYS} дней`,
      tracks: fresh,
    });
  }

  /* --- лайки: перемешать, чтобы «любимое» не открывалось одним и тем же --- */
  const liked = valid.filter((track) => track.liked);
  if (liked.length > 1) {
    sections.push({
      key: 'liked-mix',
      title: 'Из любимого',
      reason: 'перемешано, чтобы не приедалось',
      tracks: shuffle(liked, seed).slice(0, limit),
    });
  }

  return sections;
}

/** «Доброе утро/день/вечер» — единственная попытка подстроиться под время. */
export function greeting(now = Date.now()) {
  const hour = new Date(now).getHours();
  if (hour < 5) return 'Доброй ночи';
  if (hour < 12) return 'Доброе утро';
  if (hour < 18) return 'Добрый день';
  return 'Добрый вечер';
}

/** Пустая история — не ошибка: объясняем, что сделать, чтобы подборки появились. */
export function emptyHint(hasTracks) {
  return hasTracks
    ? 'Послушайте пару треков — и здесь появятся подборки по вашей истории.'
    : 'Библиотека пуста. Загрузите треки, и подборки соберутся сами.';
}
