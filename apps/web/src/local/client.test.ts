import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalClient } from './client';

/** Минимальный WAV-заголовок — содержимое для IndexedDB не важно. */
function fakeAudio(size = 1024): Blob {
  const bytes = new Uint8Array(size);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  return new Blob([bytes], { type: 'audio/wav' });
}

test('локальный режим: загрузка, поиск, лайк, статистика', async () => {
  const client = new LocalClient();

  const progress: number[] = [];
  const first = await client.uploadTrack(
    fakeAudio(),
    { title: 'Midnight Drive', artist: 'Vision Labs', genre: 'Synthwave', duration: 32, peaks: [0.2, 0.9] },
    (percent) => progress.push(percent)
  );
  const second = await client.uploadTrack(fakeAudio(2048), {
    title: 'Slow Tide',
    artist: 'Vision Labs',
    genre: 'Ambient',
    duration: 40,
  });

  assert.equal(progress.at(-1), 100);
  assert.equal(first.peaks?.length, 2);
  assert.ok(first.cover === false);

  const all = await client.tracks();
  assert.equal(all.length, 2);
  assert.ok(all[0].title, 'у трека есть название');
  assert.equal((await client.tracks()).every((track) => !('blob' in track)), true);

  const byTitle = await client.tracks({ sort: 'title' });
  assert.equal(byTitle[0].title, 'Midnight Drive');

  const search = await client.tracks({ q: 'ambient' });
  assert.equal(search.length, 1);
  assert.equal(search[0].id, second.id);

  await client.setLiked(first.id, true);
  await client.registerPlay(first.id);
  const stats = await client.stats();
  assert.equal(stats.tracks, 2);
  assert.equal(stats.liked, 1);
  assert.equal(stats.plays, 1);
  assert.equal(stats.duration, 72);
  assert.equal(stats.genres[0].count, 1);

  assert.match(client.streamUrl(first.id), /^blob:/);
});

test('локальный режим: плейлисты и удаление трека', async () => {
  const client = new LocalClient();
  const all = await client.tracks();
  const midnight = all.find((track) => track.title === 'Midnight Drive');
  const slow = all.find((track) => track.title === 'Slow Tide');
  assert.ok(midnight && slow, 'тестовые треки на месте');

  const playlist = await client.createPlaylist('Вечерняя поездка');
  await client.addToPlaylist(playlist.id, midnight.id);
  await client.addToPlaylist(playlist.id, slow.id);
  await client.addToPlaylist(playlist.id, midnight.id); // дубликат игнорируется

  const inPlaylist = await client.playlistTracks(playlist.id);
  assert.equal(inPlaylist.length, 2);

  const listed = await client.playlists();
  assert.equal(listed[0].trackCount, 2);
  assert.equal(listed[0].duration, 72);

  await client.removeFromPlaylist(playlist.id, midnight.id);
  assert.equal((await client.playlistTracks(playlist.id)).length, 1);

  await client.deleteTrack(midnight.id);
  assert.equal((await client.tracks()).length, 1);
  assert.equal((await client.playlistTracks(playlist.id)).length, 1, 'в плейлисте остался только Slow Tide');
  assert.equal((await client.playlistTracks(playlist.id))[0].title, 'Slow Tide');

  // удаляем последний трек — плейлист должен опустеть
  await client.deleteTrack(slow.id);
  assert.equal((await client.playlistTracks(playlist.id)).length, 0);

  await client.deletePlaylist(playlist.id);
  assert.equal((await client.playlists()).length, 0);
  assert.equal((await client.tracks()).length, 0);
});

test('локальный режим: данные переживают перезапуск клиента', async () => {
  const writer = new LocalClient();
  const created = await writer.uploadTrack(fakeAudio(4096), {
    title: 'Persisted Track',
    artist: 'Test',
    duration: 5,
  });

  const reader = new LocalClient();
  const found = await reader.tracks({ q: 'persisted' });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, created.id);

  const me = await reader.me();
  assert.equal(me.ok, true);
  assert.equal((await reader.login('что угодно')).token, 'local');
});
