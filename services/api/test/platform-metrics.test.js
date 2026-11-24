import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformHttpMetrics, platformMetricRoute } from '../src/platform/metrics.js';

test('HTTP metrics use route templates rather than recording track identifiers or query values', () => {
  const trackId = '12345678-1234-4234-8234-123456789012';
  assert.equal(platformMetricRoute(`/api/v2/tracks/${trackId}/publish`), '/api/v2/tracks/{id}/publish');
  assert.equal(platformMetricRoute(`/api/v2/tracks/${trackId}`), '/api/v2/tracks/{id}');
  assert.equal(platformMetricRoute('/api/v2/private/arbitrary-user-value?email=hidden'), 'unmatched');

  const metrics = new PlatformHttpMetrics();
  metrics.record({ method: 'GET', route: '/api/v2/catalog', status: 200, durationSeconds: 0.007 });
  metrics.record({ method: 'GET', route: '/api/v2/catalog', status: 200, durationSeconds: 0.4 });
  metrics.record({ method: 'GET', route: platformMetricRoute(`/api/v2/tracks/${trackId}`), status: 404, durationSeconds: 0.01 });
  const body = metrics.render();

  assert.match(body, /vision_platform_http_requests_total\{method="GET",route="\/api\/v2\/catalog",status="200"\} 2/);
  assert.match(body, /vision_platform_http_request_duration_seconds_bucket\{method="GET",route="\/api\/v2\/catalog",status="200",le="0\.01"\} 1/);
  assert.match(body, /vision_platform_http_request_duration_seconds_count\{method="GET",route="\/api\/v2\/catalog",status="200"\} 2/);
  assert.match(body, /route="\/api\/v2\/tracks\/\{id\}"/);
  assert.doesNotMatch(body, new RegExp(trackId));
});
