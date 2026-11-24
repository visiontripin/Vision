// @ts-check

const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const STATIC_ROUTES = new Set([
  '/metrics',
  '/api/v2/health',
  '/api/v2/openapi.json',
  '/api/v2/auth/register',
  '/api/v2/auth/login',
  '/api/v2/auth/refresh',
  '/api/v2/auth/logout',
  '/api/v2/me',
  '/api/v2/me/artist',
  '/api/v2/catalog',
  '/api/v2/moderation/queue',
  '/api/v2/claims',
  '/api/v2/admin/claims',
  '/api/v2/uploads',
  '/api/v2/playback/sessions',
  '/api/v2/events',
  '/api/v2/recommendations',
  '/api/v2/voice/render',
  '/api/v2/radio/session',
]);

/** @type {Array<[RegExp, string]>} */
const DYNAMIC_ROUTES = [
  [/^\/api\/v2\/tracks\/[^/]+\/publish$/, '/api/v2/tracks/{id}/publish'],
  [/^\/api\/v2\/tracks\/[^/]+\/media$/, '/api/v2/tracks/{id}/media'],
  [/^\/api\/v2\/tracks\/[^/]+$/, '/api/v2/tracks/{id}'],
  [/^\/api\/v2\/moderation\/[^/]+\/decision$/, '/api/v2/moderation/{id}/decision'],
  [/^\/api\/v2\/claims\/[^/]+\/counter$/, '/api/v2/claims/{id}/counter'],
  [/^\/api\/v2\/uploads\/[^/]+\/complete$/, '/api/v2/uploads/{id}/complete'],
  [/^\/api\/v2\/playback\/sessions\/[^/]+\/revoke$/, '/api/v2/playback/sessions/{id}/revoke'],
  [/^\/api\/v2\/radio\/[^/]+\/(?:next|skip|feedback)$/, '/api/v2/radio/{id}/action'],
];

/** Map untrusted paths to a small, fixed label set; never expose IDs or query data. */
export function platformMetricRoute(pathname) {
  if (STATIC_ROUTES.has(pathname)) return pathname;
  for (const [pattern, label] of DYNAMIC_ROUTES) {
    if (pattern.test(pathname)) return label;
  }
  return 'unmatched';
}

function escapeLabel(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

/** Bounded-cardinality in-process HTTP counters/histograms for one API instance. */
export class PlatformHttpMetrics {
  #observations = new Map();

  record({ method, route, status, durationSeconds }) {
    const safeMethod = HTTP_METHODS.has(method) ? method : 'OTHER';
    const safeRoute = STATIC_ROUTES.has(route) || DYNAMIC_ROUTES.some(([, label]) => label === route)
      ? route : 'unmatched';
    const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
    const safeDuration = Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : 0;
    const key = `${safeMethod}\0${safeRoute}\0${safeStatus}`;
    let item = this.#observations.get(key);
    if (!item) {
      item = { method: safeMethod, route: safeRoute, status: safeStatus, count: 0, sum: 0, buckets: Array(HISTOGRAM_BUCKETS.length).fill(0) };
      this.#observations.set(key, item);
    }
    item.count += 1;
    item.sum += safeDuration;
    HISTOGRAM_BUCKETS.forEach((bucket, index) => {
      if (safeDuration <= bucket) item.buckets[index] += 1;
    });
  }

  render() {
    const lines = [
      '# HELP vision_platform_http_requests_total Completed HTTP requests by method, route template and status.',
      '# TYPE vision_platform_http_requests_total counter',
      '# HELP vision_platform_http_request_duration_seconds HTTP request duration in seconds.',
      '# TYPE vision_platform_http_request_duration_seconds histogram',
    ];
    const sorted = [...this.#observations.values()].sort((a, b) =>
      a.method.localeCompare(b.method) || a.route.localeCompare(b.route) || a.status - b.status);
    for (const item of sorted) {
      const labels = `method="${escapeLabel(item.method)}",route="${escapeLabel(item.route)}",status="${item.status}"`;
      lines.push(`vision_platform_http_requests_total{${labels}} ${item.count}`);
      HISTOGRAM_BUCKETS.forEach((bucket, index) => {
        lines.push(`vision_platform_http_request_duration_seconds_bucket{${labels},le="${bucket}"} ${item.buckets[index]}`);
      });
      lines.push(`vision_platform_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${item.count}`);
      lines.push(`vision_platform_http_request_duration_seconds_sum{${labels}} ${item.sum}`);
      lines.push(`vision_platform_http_request_duration_seconds_count{${labels}} ${item.count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
