#!/usr/bin/env node
/**
 * Демо-наполнение библиотеки: генерирует короткие WAV-треки и загружает их в API.
 * Полезно для проверки плеера на пустом окружении.
 *
 * Запуск: node scripts/seed-demo.mjs   (API должен слушать localhost:4000)
 * Пароль берётся из VISION_PASSWORD или 'vision'.
 */

const BASE = (process.env.API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const PASSWORD = process.env.VISION_PASSWORD || 'vision';
const SAMPLE_RATE = 44100;

const TRACKS = [
  {
    file: 'midnight-drive.wav',
    title: 'Midnight Drive',
    artist: 'Vision Labs',
    album: 'Night Shift',
    genre: 'Synthwave',
    seconds: 32,
    root: 220.0,
    chords: [[0, 3, 7, 10], [-2, 2, 5, 9], [-4, 0, 3, 7], [-5, -1, 2, 7]],
    tempo: 104,
    pad: 0.35,
    arp: 0.5,
    kick: true,
  },
  {
    file: 'slow-tide.wav',
    title: 'Slow Tide',
    artist: 'Vision Labs',
    album: 'Night Shift',
    genre: 'Ambient',
    seconds: 40,
    root: 164.81,
    chords: [[0, 4, 7, 11], [2, 5, 9, 12], [-3, 2, 7, 10], [0, 4, 7, 14]],
    tempo: 62,
    pad: 0.6,
    arp: 0.18,
    kick: false,
  },
  {
    file: 'neon-rain.wav',
    title: 'Neon Rain',
    artist: 'Kira Voss',
    album: 'Chrome Garden',
    genre: 'Electronica',
    seconds: 30,
    root: 261.63,
    chords: [[0, 3, 7, 12], [-1, 4, 7, 11], [-3, 1, 5, 8], [-5, 0, 5, 10]],
    tempo: 118,
    pad: 0.28,
    arp: 0.6,
    kick: true,
  },
  {
    file: 'paper-planes.wav',
    title: 'Paper Planes',
    artist: 'Kira Voss',
    album: 'Chrome Garden',
    genre: 'Lo-fi',
    seconds: 36,
    root: 196.0,
    chords: [[0, 4, 7, 11], [-3, 0, 4, 7], [-5, 2, 5, 9], [0, 4, 7, 12]],
    tempo: 86,
    pad: 0.4,
    arp: 0.35,
    kick: true,
  },
  {
    file: 'static-bloom.wav',
    title: 'Static Bloom',
    artist: 'North Loop',
    album: 'Signals',
    genre: 'Drone',
    seconds: 45,
    root: 130.81,
    chords: [[0, 5, 7, 12], [0, 5, 10, 12], [-2, 3, 8, 10], [0, 5, 7, 14]],
    tempo: 54,
    pad: 0.65,
    arp: 0.12,
    kick: false,
  },
];

function semitone(root, steps) {
  return root * 2 ** (steps / 12);
}

/** Простой рендер: пэд из аккордов + арпеджио + опциональный «кик». */
function render(track) {
  const samples = Math.floor(SAMPLE_RATE * track.seconds);
  const data = new Float32Array(samples);
  const barSeconds = (60 / track.tempo) * 4;
  const bars = Math.ceil(track.seconds / barSeconds);

  for (let i = 0; i < samples; i += 1) {
    const t = i / SAMPLE_RATE;
    const bar = Math.min(bars - 1, Math.floor(t / barSeconds));
    const chord = track.chords[bar % track.chords.length];
    const chordStart = bar * barSeconds;

    let value = 0;

    // пэд
    for (const step of chord) {
      const f = semitone(track.root, step);
      value += Math.sin(2 * Math.PI * f * t) * track.pad * 0.16;
      value += Math.sin(2 * Math.PI * f * 1.004 * t) * track.pad * 0.08;
    }

    // арпеджио
    const noteLength = 60 / track.tempo / 2;
    const noteIndex = Math.floor((t - chordStart) / noteLength);
    const step = chord[((noteIndex % chord.length) + chord.length) % chord.length];
    const noteFreq = semitone(track.root, step + 12);
    const sinceNote = t - chordStart - noteIndex * noteLength;
    const noteEnv = Math.exp(-sinceNote * 7) * Math.min(1, sinceNote * 60);
    value += (Math.sin(2 * Math.PI * noteFreq * t) + 0.35 * Math.sin(4 * Math.PI * noteFreq * t)) *
      noteEnv * track.arp * 0.28;

    // мягкий ритм
    if (track.kick) {
      const beat = 60 / track.tempo;
      const sinceBeat = t % beat;
      value += Math.sin(2 * Math.PI * (58 - sinceBeat * 40) * sinceBeat) * Math.exp(-sinceBeat * 18) * 0.18;
    }

    const fadeIn = Math.min(1, t / 2.5);
    const fadeOut = Math.min(1, (track.seconds - t) / 3);
    value *= Math.max(0, Math.min(fadeIn, fadeOut));
    data[i] = Math.tanh(value) * 0.85;
  }

  return data;
}

function toWav(data) {
  const buffer = Buffer.alloc(44 + data.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + data.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i += 1) {
    buffer.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(data[i] * 32767))), 44 + i * 2);
  }
  return buffer;
}

function peaks(data, count = 180) {
  const block = Math.max(1, Math.floor(data.length / count));
  const raw = [];
  let max = 0;
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    let n = 0;
    for (let j = i * block; j < Math.min(data.length, (i + 1) * block); j += 16) {
      sum += data[j] * data[j];
      n += 1;
    }
    const rms = Math.sqrt(sum / Math.max(1, n));
    raw.push(rms);
    max = Math.max(max, rms);
  }
  return raw.map((value) => Math.max(0.04, Number((value / (max || 1)).toFixed(3))));
}

const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

const main = async () => {
  const { token } = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const auth = { Authorization: `Bearer ${token}` };
  const existing = await api('/api/tracks', { headers: auth });
  const existingTitles = new Set(existing.map((track) => track.title));
  const created = [];

  for (const track of TRACKS) {
    if (existingTitles.has(track.title)) {
      console.log(`· ${track.title} — уже в библиотеке`);
      continue;
    }
    console.log(`… рендер ${track.title}`);
    const data = render(track);
    const wav = toWav(data);
    const query = new URLSearchParams({
      title: track.title,
      artist: track.artist,
      album: track.album,
      genre: track.genre,
      duration: String(track.seconds),
      peaks: JSON.stringify(peaks(data)),
      filename: track.file,
    });

    const createdTrack = await api(`/api/tracks?${query}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'audio/wav' },
      body: wav,
    });
    created.push(createdTrack);
    console.log(`✓ ${track.title} (${(wav.length / 1024 / 1024).toFixed(1)} МБ)`);
  }

  const all = await api('/api/tracks', { headers: auth });
  if (all.length && !all.some((track) => track.liked)) {
    await api(`/api/tracks/${all[0].id}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ liked: true }),
    });
  }

  for (const track of all.slice(0, 3)) {
    await api(`/api/tracks/${track.id}/play`, { method: 'POST', headers: auth });
  }

  const playlists = await api('/api/playlists', { headers: auth });
  let nightDrive = playlists.find((playlist) => playlist.name === 'Ночная поездка');
  if (!nightDrive) {
    nightDrive = await api('/api/playlists', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ночная поездка', description: 'Синтвейв и мягкая электроника' }),
    });
  }
  for (const track of all.filter((item) => ['Synthwave', 'Electronica', 'Lo-fi'].includes(item.genre)).slice(0, 3)) {
    await api(`/api/playlists/${nightDrive.id}/tracks`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId: track.id }),
    });
  }

  console.log(`\nГотово: ${all.length} треков, плейлистов: ${(await api('/api/playlists', { headers: auth })).length}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
