import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_LIBRARY,
  EMPTY_STATS,
  addToPlaylist,
  createPlaylist,
  listTracks,
  localId,
  localUriOf,
  playlistToModel,
  prunePlaylists,
  recordPlay,
  registerFile,
  removeFile,
  secondsInLastDays,
  topTracks,
  totalBytes,
  upsertMeta,
} from './local';

const file = (key: string, extra: Partial<Parameters<typeof registerFile>[1]> = {}) => ({
  key,
  uri: `file:///music/${key}`,
  title: key,
  bytes: 1000,
  ...extra,
});

test('id трека стабилен для одного пути и различается для разных', () => {
  assert.equal(localId('file:///music/a.mp3'), localId('file:///music/a.mp3'));
  assert.notEqual(localId('file:///music/a.mp3'), localId('file:///music/b.mp3'));
  assert.match(localId('x'), /^loc_[a-z0-9]+$/);
});

test('повторный импорт той же папки не задваивает треки и не сбрасывает дату', () => {
  const first = registerFile(EMPTY_LIBRARY, file('a.mp3'), { title: 'A' });
  assert.equal(first.added, true);
  const second = registerFile(first.library, file('a.mp3'), { title: 'A' });
  assert.equal(second.added, false);
  assert.equal(second.id, first.id);
  assert.equal(Object.keys(second.library.entries).length, 1);
  assert.equal(second.library.entries[first.id].addedAt, first.library.entries[first.id].addedAt);
});

test('удаление файла убирает ровно одну запись', () => {
  let library = registerFile(EMPTY_LIBRARY, file('a.mp3'), { title: 'A' }).library;
  const added = registerFile(library, file('b.mp3'), { title: 'B' });
  library = removeFile(added.library, added.id);
  assert.equal(Object.keys(library.entries).length, 1);
  // повторное удаление — не ошибка и не меняет объект
  assert.equal(removeFile(library, added.id), library);
});

test('новые треки сверху, метаданные подставляются из отдельной записи', () => {
  const first = registerFile(EMPTY_LIBRARY, file('old.mp3'), { title: 'old.mp3' }, { title: 'old.mp3' });
  const second = registerFile(first.library, file('new.mp3', { addedAt: Date.now() + 1000 }), { title: 'new.mp3' });
  const metas = upsertMeta({}, second.id, { title: 'Свежий', artist: 'Кто-то', duration: 200 });
  const tracks = listTracks(second.library, metas);
  assert.equal(tracks[0].id, second.id);
  assert.equal(tracks[0].title, 'Свежий');
  assert.equal(tracks[0].artist, 'Кто-то');
  assert.equal(tracks[0].duration, 200);
  // без метаданных — имя файла без расширения, а не «Без названия»
  assert.equal(tracks[1].title, 'old');
  assert.equal(tracks[1].artist, '');
});

test('плеер получает локальный uri по id и по контрольной сумме', () => {
  const { library, id } = registerFile(EMPTY_LIBRARY, file('a.mp3', { checksum: 'abc' }), { title: 'A' });
  assert.equal(localUriOf(library, id), 'file:///music/a.mp3');
  assert.equal(localUriOf(library, 'abc'), 'file:///music/a.mp3');
  assert.equal(localUriOf(library, 'нет-такого'), null);
  assert.equal(localUriOf(library, null), null);
});

test('имя файла «Artist - Title» разбирается, когда тегов нет', () => {
  const { library } = registerFile(EMPTY_LIBRARY, {
    key: 'x',
    uri: 'file:///music/Кино - Группа крови.mp3',
    title: 'x',
  }, { title: 'x' });
  const [track] = listTracks(library, {});
  assert.equal(track.artist, 'Кино');
  assert.equal(track.title, 'Группа крови');
});

test('локальный трек всегда доступен: источник — сам файл', () => {
  const { library, id } = registerFile(EMPTY_LIBRARY, file('a.mp3'), { title: 'A' });
  const [track] = listTracks(library, {});
  assert.equal(track.available, true);
  assert.equal(track.id, id);
  assert.equal(totalBytes(library), 1000);
});

test('плейлист переживает удаление трека и не показывает фантомов', () => {
  const { library, id } = registerFile(EMPTY_LIBRARY, file('a.mp3'), { title: 'A' });
  const created = createPlaylist([], 'Дорога');
  const withTrack = addToPlaylist(created.playlists, created.id, id);
  // повторное добавление не дублирует
  const twice = addToPlaylist(withTrack, created.id, id);
  assert.equal(twice[0].trackIds.length, 1);

  const tracks = listTracks(library, {});
  assert.equal(playlistToModel(twice[0], tracks).trackCount, 1);
  assert.equal(playlistToModel(twice[0], tracks).duration, 0);

  // файл удалили — плейлист хранит id, но списка треков больше нет
  const pruned = prunePlaylists(twice, new Set());
  assert.deepEqual(pruned[0].trackIds, []);
});

test('статистика: счётчики, свежесть и окно по дням', () => {
  const now = Date.now();
  let stats = EMPTY_STATS;
  stats = recordPlay(stats, { trackId: 'a', seconds: 120, at: now - 3600_000 });
  stats = recordPlay(stats, { trackId: 'a', seconds: 60, at: now - 1800_000 });
  stats = recordPlay(stats, { trackId: 'b', seconds: 30, at: now - 1000 });
  // нулевое прослушивание не считается
  stats = recordPlay(stats, { trackId: 'c', seconds: 0, at: now });

  const top = topTracks(stats, 5);
  assert.deepEqual(top.map((row) => row.trackId), ['a', 'b']);
  assert.equal(top[0].plays, 2);
  assert.equal(secondsInLastDays(stats, 1, now), 210);
  assert.equal(secondsInLastDays(stats, 0, now), 0);
  assert.equal(topTracks(stats, 0).length, 0);
});
