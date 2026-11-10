/**
 * Клиентский анализ аудио: имя → исполнитель/название, длительность и 180 пиков
 * через Web Audio API. Используется и одиночной загрузкой, и массовым импортом.
 */

export const AUDIO_RE = /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|aiff|aif)$/i;

export const isAudioFile = (file: File) => AUDIO_RE.test(file.name) || file.type.startsWith('audio/');

/**
 * «Artist - Title.mp3» → { artist, title }.
 * «01 - Title.mp3» и «01. Title.mp3» — это номер трека, а не исполнитель.
 */
export function parseName(filename: string): { title: string; artist: string } {
  const base = filename
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const parts = base.split(/\s+-\s+/);
  if (parts.length >= 2) {
    const left = parts[0].trim();
    const right = parts.slice(1).join(' - ').trim();
    if (/^\d{1,3}[.)]?$/.test(left)) {
      return { artist: 'Unknown', title: right || base };
    }
    if (left && right) return { artist: left, title: right };
  }

  const numbered = /^\d{1,3}[.)]?\s+(.*)$/.exec(base);
  if (numbered) return { artist: 'Unknown', title: numbered[1].trim() };

  return { title: base || 'Без названия', artist: 'Unknown' };
}

const PEAK_COUNT = 320;
const MAX_DECODE_BYTES = 160 * 1024 * 1024;

/** Длительность + 320 нормализованных пиков. Никогда не бросает. */
export async function analyze(file: File): Promise<{ duration: number; peaks: number[] | null }> {
  let duration = 0;
  let peaks: number[] | null = null;

  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (typeof Ctor === 'function' && file.size < MAX_DECODE_BYTES) {
      const context = new Ctor();
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      const channel = buffer.getChannelData(0);
      const block = Math.max(1, Math.floor(channel.length / PEAK_COUNT));
      const raw: number[] = [];
      let max = 0;
      for (let i = 0; i < PEAK_COUNT; i += 1) {
        const start = i * block;
        const end = Math.min(channel.length, start + block);
        let sum = 0;
        let samples = 0;
        for (let j = start; j < end; j += 8) {
          sum += channel[j] * channel[j];
          samples += 1;
        }
        const rms = Math.sqrt(sum / Math.max(1, samples));
        raw.push(rms);
        if (rms > max) max = rms;
      }
      peaks = max > 0 ? raw.map((value) => Math.max(0.04, Number((value / max).toFixed(3)))) : raw;
      duration = buffer.duration;
      await context.close();
    }
  } catch {
    peaks = null;
  }

  if (!duration) {
    duration = await new Promise<number>((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      audio.preload = 'metadata';
      const done = (value: number) => {
        URL.revokeObjectURL(url);
        resolve(value);
      };
      audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : 0);
      audio.onerror = () => done(0);
      audio.src = url;
    });
  }

  return { duration, peaks };
}
