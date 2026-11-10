/**
 * Минимальный Prometheus-совместимый реестр метрик: счётчики, gauge'и и одна
 * гистограмма задержек. Без зависимостей — на выходе обычный текстовый формат
 * exposition 0.0.4.
 */

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const HISTOGRAM_NAME = 'vision_http_request_duration_seconds';
const startedAt = Date.now();

const counters = new Map();
const gauges = new Map();
const histograms = new Map();

const escapeLabel = (value) =>
  String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** `a="1",b="2"` либо '' для пустого набора меток. */
function labelPairs(labels = {}, extra) {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (extra) entries.push(extra);
  return entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',');
}

const withLabels = (name, labels, extra) => {
  const pairs = labelPairs(labels, extra);
  return pairs ? `${name}{${pairs}}` : name;
};

export function inc(name, value = 1, labels = {}) {
  const key = withLabels(name, labels);
  const current = counters.get(key);
  if (current) current.value += value;
  else counters.set(key, { name, labels, value });
}

export function setGauge(name, value, labels = {}) {
  gauges.set(withLabels(name, labels), { name, labels, value });
}

export function observeDuration(seconds, labels = {}) {
  const key = withLabels(HISTOGRAM_NAME, labels);
  let entry = histograms.get(key);
  if (!entry) {
    entry = {
      labels,
      buckets: DURATION_BUCKETS.map((value) => ({ value, count: 0 })),
      sum: 0,
      count: 0,
    };
    histograms.set(key, entry);
  }
  entry.sum += seconds;
  entry.count += 1;
  for (const bucket of entry.buckets) {
    if (seconds <= bucket.value) bucket.count += 1;
  }
}

/** Сбрасывает всё состояние — нужно тестам. */
export function resetMetrics() {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

export function renderMetrics(extraGauges = {}) {
  const lines = [];
  const declared = new Set();

  const declare = (name, type, help) => {
    if (declared.has(name)) return;
    declared.add(name);
    if (help) lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
  };

  lines.push('# HELP vision_uptime_seconds Время работы процесса в секундах');
  lines.push('# TYPE vision_uptime_seconds gauge');
  lines.push(`vision_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(3)}`);

  // gauge'и приложения: значения из БД + явные setGauge
  const allGauges = new Map();
  for (const [name, value] of Object.entries(extraGauges)) {
    if (value === null || value === undefined) continue;
    allGauges.set(name, { name, labels: {}, value });
  }
  for (const [key, entry] of gauges) {
    if (entry.value === null || entry.value === undefined) continue;
    allGauges.set(key, entry);
  }
  for (const [key, entry] of [...allGauges].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    declare(entry.name, 'gauge');
    lines.push(`${key} ${entry.value}`);
  }

  if (counters.size) {
    for (const [key, entry] of [...counters].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      declare(entry.name, 'counter', 'Счётчики приложения');
      lines.push(`${key} ${entry.value}`);
    }
  }

  if (histograms.size) {
    declare(HISTOGRAM_NAME, 'histogram', 'Длительность HTTP-запросов в секундах');
    for (const [key, entry] of [...histograms].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      for (const bucket of entry.buckets) {
        lines.push(`${withLabels(`${HISTOGRAM_NAME}_bucket`, entry.labels, ['le', String(bucket.value)])} ${bucket.count}`);
      }
      lines.push(`${withLabels(`${HISTOGRAM_NAME}_bucket`, entry.labels, ['le', '+Inf'])} ${entry.count}`);
      lines.push(`${withLabels(`${HISTOGRAM_NAME}_sum`, entry.labels)} ${entry.sum}`);
      lines.push(`${withLabels(`${HISTOGRAM_NAME}_count`, entry.labels)} ${entry.count}`);
      void key;
    }
  }

  return `${lines.join('\n')}\n`;
}
