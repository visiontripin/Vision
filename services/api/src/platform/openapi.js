export const PLATFORM_OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Vision Platform API',
    version: '2.0.0',
    description: 'Isolated server-side identity, catalog, moderation, and rights-claims contract. Registration is closed by default.',
  },
  paths: {
    '/api/v2/health': {
      get: {
        operationId: 'platformHealth',
        responses: {
          200: { description: 'Database and platform schema are ready.' },
          503: { description: 'Database or platform schema is not ready.' },
        },
      },
    },
    '/api/v2/openapi.json': {
      get: { operationId: 'getPlatformOpenApi', responses: { 200: { description: 'This OpenAPI document.' } } },
    },
    '/api/v2/auth/register': {
      post: {
        operationId: 'registerWithPassword',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterRequest' } } },
        },
        responses: {
          201: { description: 'Account and initial tokens created.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } },
          400: { description: 'Invalid registration input.' },
          403: { description: 'Registration is disabled.' },
          409: { description: 'Email is already registered.' },
        },
      },
    },
    '/api/v2/auth/login': {
      post: {
        operationId: 'loginWithPassword',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
        },
        responses: {
          200: { description: 'Authentication tokens issued.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } },
          401: { description: 'Invalid credentials.' },
        },
      },
    },
    '/api/v2/auth/refresh': {
      post: {
        operationId: 'rotateRefreshToken',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RefreshRequest' } } },
        },
        responses: {
          200: { description: 'Refresh token rotated.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } },
          401: { description: 'Invalid, expired, or replayed refresh token.' },
        },
      },
    },
    '/api/v2/auth/logout': {
      post: {
        operationId: 'revokeRefreshToken',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RefreshRequest' } } },
        },
        responses: { 200: { description: 'Refresh session revoked.' } },
      },
    },
    '/api/v2/me': {
      get: {
        operationId: 'getCurrentUser',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'Current active user.', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          401: { description: 'Missing or invalid bearer token.' },
        },
      },
      patch: {
        operationId: 'updateCurrentUserProfile',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ProfilePatch' } } },
        },
        responses: {
          200: { description: 'Updated profile.', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          400: { description: 'Invalid profile input.' },
          401: { description: 'Missing or invalid bearer token.' },
        },
      },
    },
    '/api/v2/me/artist': {
      post: {
        operationId: 'createArtistProfile',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ArtistProfileRequest' } } },
        },
        responses: {
          201: { description: 'Artist profile created after explicit acknowledgement.' },
          400: { description: 'Invalid input or rights acknowledgement missing.' },
          401: { description: 'Missing or invalid bearer token.' },
          409: { description: 'Profile or stage name already exists.' },
        },
      },
    },
    '/api/v2/moderation/queue': {
      get: {
        operationId: 'listModerationQueue',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'assigned', 'escalated'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 } },
        ],
        responses: {
          200: {
            description: 'Open moderation tasks; moderator/admin role required.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items'],
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/ModerationItem' } },
                  },
                },
              },
            },
          },
          401: { description: 'Missing or invalid bearer token.' },
          403: { description: 'Moderator/admin role required.' },
        },
      },
    },
    '/api/v2/moderation/{id}/decision': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: {
        operationId: 'decideModeration', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ModerationDecision' } } } },
        responses: {
          200: {
            description: 'Decision recorded and track state changed atomically.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ModerationDecisionResponse' } } },
          },
          401: { description: 'Missing or invalid bearer token.' }, 403: { description: 'Moderator/admin role required.' },
          409: { description: 'Stale item, unresolved rights claim, or invalid state transition.' },
        },
      },
    },
    '/api/v2/claims': {
      post: {
        operationId: 'createRightsClaim',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RightsClaimRequest' } } } },
        responses: {
          201: {
            description: 'Rights claim created; a public or in-review track is immediately hidden.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RightsClaim' } } },
          },
          400: { description: 'Invalid notice.' }, 404: { description: 'Track not found.' },
        },
      },
    },
    '/api/v2/claims/{id}/counter': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: {
        operationId: 'fileCounterNotice', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CounterNoticeRequest' } } } },
        responses: {
          200: {
            description: 'Owner counter-notice recorded; track remains unavailable pending review.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CounterNoticeResponse' } } },
          },
          401: { description: 'Missing or invalid bearer token.' }, 403: { description: 'Only the track owner/admin can counter.' },
          404: { description: 'Claim not found.' }, 409: { description: 'Claim is not open.' },
        },
      },
    },
    '/api/v2/admin/claims': {
      get: {
        operationId: 'listRightsClaims', security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'accepted', 'rejected', 'counter_notice'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 } },
        ],
        responses: {
          200: {
            description: 'Rights registry including claimant contact, admin only.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RightsClaimsPage' } } },
          },
          401: { description: 'Missing or invalid bearer token.' }, 403: { description: 'Admin role required.' },
        },
      },
    },
    '/api/v2/catalog': {
      get: {
        operationId: 'listPublicCatalog',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string', maxLength: 120 } },
          { name: 'genre', in: 'query', schema: { type: 'string', maxLength: 100 } },
          { name: 'mood', in: 'query', schema: { type: 'string', maxLength: 50 } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['recent', 'relevance', 'popular', 'title'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 } },
        ],
        responses: {
          200: { description: 'Only published, public and rights-confirmed tracks.', content: { 'application/json': { schema: { $ref: '#/components/schemas/CatalogPage' } } } },
          400: { description: 'Invalid search or pagination input.' },
        },
      },
    },
    '/api/v2/events': {
      post: {
        operationId: 'ingestPlayEvents', security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PlayEventBatch' } } },
        },
        responses: {
          202: { description: 'Privacy-minimal play events; repeated event ids are ignored.', content: { 'application/json': { schema: { $ref: '#/components/schemas/PlayEventBatchResponse' } } } },
          400: { description: 'Invalid event batch or event fields.' },
          401: { description: 'Missing or invalid bearer token.' },
          404: { description: 'A referenced track is not publicly available.' },
        },
      },
    },
    '/api/v2/recommendations': {
      get: {
        operationId: 'getRecommendations', security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'genre', in: 'query', schema: { type: 'string', maxLength: 100 } },
          { name: 'mood', in: 'query', schema: { type: 'string', maxLength: 50 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
        ],
        responses: {
          200: { description: 'Deterministic rights-filtered candidate ranking for the authenticated user.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecommendationsResponse' } } } },
          400: { description: 'Invalid filter or limit.' }, 401: { description: 'Missing or invalid bearer token.' },
        },
      },
    },
    '/api/v2/radio/session': {
      post: {
        operationId: 'startRadioSession', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RadioSessionRequest' } } } },
        responses: {
          201: { description: 'Private server-side music-only schedule; ads and editorial segments remain disabled.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RadioSessionResponse' } } } },
          401: { description: 'Missing or invalid bearer token.' }, 503: { description: 'Private media storage is unavailable.' },
        },
      },
    },
    '/api/v2/radio/{sessionId}/next': {
      parameters: [
        { name: 'sessionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'ahead', in: 'query', schema: { type: 'integer', minimum: 60, maximum: 900, default: 900 } },
      ],
      get: {
        operationId: 'getRadioSchedule', security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'Owner-scoped schedule window with short-lived private media URLs.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RadioSchedule' } } } },
          401: { description: 'Missing or invalid bearer token.' }, 404: { description: 'Radio session not found.' },
          409: { description: 'Radio session is no longer active.' },
        },
      },
    },
    '/api/v2/radio/{sessionId}/skip': {
      parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: {
        operationId: 'skipRadioSegment', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RadioSkipRequest' } } } },
        responses: {
          200: { description: 'Skip feedback saved and the remaining schedule refreshed.' },
          401: { description: 'Missing or invalid bearer token.' }, 404: { description: 'Session or segment not found.' },
        },
      },
    },
    '/api/v2/radio/{sessionId}/feedback': {
      parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: {
        operationId: 'recordRadioFeedback', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RadioFeedbackRequest' } } } },
        responses: {
          200: { description: 'Owner feedback recorded for one scheduled segment.' },
          400: { description: 'Unsupported feedback reaction.' }, 401: { description: 'Missing or invalid bearer token.' },
          404: { description: 'Session or segment not found.' },
        },
      },
    },
    '/api/v2/voice/render': {
      post: {
        operationId: 'renderRadioScript', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/VoiceRenderRequest' } } } },
        responses: {
          200: { description: 'Signed private URL for a cached or generated active radio script.', content: { 'application/json': { schema: { $ref: '#/components/schemas/VoiceRenderResponse' } } } },
          400: { description: 'Unsupported voice id or invalid input.' }, 401: { description: 'Missing or invalid bearer token.' },
          403: { description: 'Moderator/admin role required.' }, 404: { description: 'Active script not found.' },
          503: { description: 'No TTS provider has been configured.' },
        },
      },
    },
    '/api/v2/uploads': {
      post: {
        operationId: 'createUploadIntent', security: [{ bearerAuth: [] }],
        parameters: [{
          name: 'Idempotency-Key', in: 'header', required: false,
          schema: { type: 'string', minLength: 1, maxLength: 200 },
        }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/UploadIntentRequest' } } },
        },
        responses: {
          201: { description: 'Private, short-lived upload intent; media remains quarantined.', content: { 'application/json': { schema: { $ref: '#/components/schemas/UploadIntentResponse' } } } },
          400: { description: 'Invalid upload metadata.' }, 401: { description: 'Missing or invalid bearer token.' },
          403: { description: 'Uploads are disabled, caller is not an artist, or quota is unconfigured.' },
          413: { description: 'Upload size exceeds the allowed limit or quota.' },
          429: { description: 'Monthly upload quota is exhausted.' }, 503: { description: 'Private object storage is unavailable.' },
        },
      },
    },
    '/api/v2/uploads/{id}/complete': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: {
        operationId: 'completeUploadIntent', security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'Object integrity verified and an idempotent ingest request recorded.', content: { 'application/json': { schema: { $ref: '#/components/schemas/UploadCompleteResponse' } } } },
          401: { description: 'Missing or invalid bearer token.' }, 403: { description: 'Caller does not own the upload.' },
          404: { description: 'Upload intent not found.' }, 409: { description: 'Upload is missing, expired, or does not match the declared metadata.' },
        },
      },
    },
    '/api/v2/tracks/{id}/publish': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: {
        operationId: 'requestTrackPublication', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PublishRequest' } } } },
        responses: {
          202: {
            description: 'Track moved to private in-review state.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TrackSubmission' } } },
          },
          400: { description: 'Rights acknowledgement is required.' }, 401: { description: 'Missing or invalid bearer token.' },
          403: { description: 'Caller does not own the track.' }, 404: { description: 'Track not found.' },
          409: { description: 'Track is not submittable or a rights claim is open.' },
        },
      },
    },
    '/api/v2/tracks/{id}/media': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        operationId: 'getTrackMediaUrl',
        parameters: [{ name: 'codec', in: 'query', schema: { type: 'string', enum: ['auto', 'opus', 'aac', 'original'], default: 'auto' } }],
        responses: {
          200: { description: 'Short-lived signed URL after visibility, moderation and rights checks.', content: { 'application/json': { schema: { $ref: '#/components/schemas/TrackMediaResponse' } } } },
          404: { description: 'Track or media is not available.' },
          503: { description: 'Private media storage is unavailable.' },
        },
      },
    },
    '/api/v2/tracks/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        operationId: 'getTrack',
        responses: {
          200: { description: 'Public track or an owner/admin-only private track.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Track' } } } },
          404: { description: 'Track not found or not visible to this user.' },
        },
      },
      patch: {
        operationId: 'updateTrackMetadata',
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TrackPatch' } } } },
        responses: {
          200: { description: 'Metadata updated; a published track is made private and queued for review.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Track' } } } },
          400: { description: 'Invalid metadata.' },
          401: { description: 'Missing or invalid bearer token.' },
          403: { description: 'Caller does not own the track.' },
          404: { description: 'Track not found.' },
          409: { description: 'Track is taken down.' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'VisionAccessToken' },
    },
    schemas: {
      RegisterRequest: {
        type: 'object', additionalProperties: false, required: ['email', 'password', 'displayName'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 254 },
          password: { type: 'string', minLength: 12, maxLength: 1024 },
          displayName: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
      LoginRequest: {
        type: 'object', additionalProperties: false, required: ['email', 'password'],
        properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', maxLength: 1024 } },
      },
      RefreshRequest: {
        type: 'object', additionalProperties: false, required: ['refreshToken'],
        properties: { refreshToken: { type: 'string', minLength: 43, maxLength: 43 } },
      },
      AuthResponse: {
        type: 'object', required: ['user', 'tokenType', 'accessToken', 'accessExpiresAt', 'accessExpiresIn', 'refreshToken', 'refreshExpiresAt'],
        properties: {
          user: { $ref: '#/components/schemas/User' }, tokenType: { const: 'Bearer' },
          accessToken: { type: 'string' }, accessExpiresAt: { type: 'string', format: 'date-time' },
          accessExpiresIn: { type: 'integer', const: 900 }, refreshToken: { type: 'string' },
          refreshExpiresAt: { type: 'string', format: 'date-time' },
        },
      },
      User: {
        type: 'object', required: ['id', 'email', 'displayName', 'role', 'locale', 'country', 'city', 'createdAt'],
        properties: {
          id: { type: 'string', format: 'uuid' }, email: { type: ['string', 'null'] },
          displayName: { type: 'string' }, role: { enum: ['listener', 'artist', 'moderator', 'admin'] },
          locale: { type: 'string' }, country: { type: ['string', 'null'] }, city: { type: ['string', 'null'] },
          createdAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      ProfilePatch: {
        type: 'object', additionalProperties: false,
        properties: {
          displayName: { type: 'string', minLength: 1, maxLength: 120 },
          locale: { type: 'string', pattern: '^[a-z]{2}(-[A-Z]{2})?$' },
          country: { type: 'string', pattern: '^(?:[A-Za-z]{2})?$' }, city: { type: 'string', maxLength: 120 },
        },
        minProperties: 1,
      },
      ArtistProfileRequest: {
        type: 'object', additionalProperties: false, required: ['stageName', 'offerVersion', 'rightsConfirmed'],
        properties: {
          stageName: { type: 'string', minLength: 1, maxLength: 120 }, bio: { type: 'string', maxLength: 5000 },
          links: { type: 'array', maxItems: 10, items: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048 } },
          offerVersion: { type: 'string', minLength: 1, maxLength: 100 }, rightsConfirmed: { const: true },
        },
      },
      CatalogPage: {
        type: 'object', required: ['items', 'total', 'limit', 'offset'],
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Track' } },
          total: { type: 'integer', minimum: 0 }, limit: { type: 'integer' }, offset: { type: 'integer' },
        },
      },
      Track: {
        type: 'object', required: ['id', 'title', 'artist', 'album', 'genre', 'mood', 'durationMs', 'plays', 'publishedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' }, title: { type: 'string' }, artist: { type: 'string' },
          album: { type: ['string', 'null'] }, genre: { type: ['string', 'null'] }, mood: { type: 'array', items: { type: 'string' } },
          durationMs: { type: ['integer', 'null'], minimum: 0 }, plays: { type: 'integer', minimum: 0 },
          publishedAt: { type: ['string', 'null'], format: 'date-time' }, ownerId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['quarantine', 'in_review', 'published', 'rejected', 'taken_down'] },
          visibility: { type: 'string', enum: ['private', 'unlisted', 'public'] },
        },
      },
      PlayEventBatch: {
        type: 'object', additionalProperties: false, required: ['events'],
        properties: {
          events: {
            type: 'array', minItems: 1, maxItems: 100, items: {
              type: 'object', additionalProperties: false,
              required: ['eventId', 'trackId', 'sessionId', 'kind', 'source', 'occurredAt'],
              properties: {
                eventId: { type: 'string', format: 'uuid' }, trackId: { type: 'string', format: 'uuid' },
                sessionId: { type: 'string', format: 'uuid' },
                kind: { type: 'string', enum: ['start', 'play_30s', 'finish', 'skip_early', 'repeat', 'segment_skip'] },
                positionMs: { type: 'integer', minimum: 0, maximum: 86400000 },
                durationMs: { type: 'integer', minimum: 0, maximum: 86400000 },
                source: { type: 'string', enum: ['wave', 'library', 'playlist', 'share', 'promo'] },
                device: { type: 'string', enum: ['web', 'mobile', 'desktop', 'unknown'] },
                occurredAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      PlayEventBatchResponse: {
        type: 'object', required: ['accepted', 'duplicates'],
        properties: { accepted: { type: 'integer', minimum: 0 }, duplicates: { type: 'integer', minimum: 0 } },
      },
      RecommendationsResponse: {
        type: 'object', required: ['modelVersion', 'items', 'limit'],
        properties: {
          modelVersion: { type: 'string' }, limit: { type: 'integer' },
          items: {
            type: 'array', items: {
              type: 'object', required: ['id', 'title', 'artist', 'reason', 'score'],
              properties: {
                id: { type: 'string', format: 'uuid' }, title: { type: 'string' }, artist: { type: 'string' },
                album: { type: ['string', 'null'] }, genre: { type: ['string', 'null'] },
                mood: { type: 'array', items: { type: 'string' } }, durationMs: { type: ['integer', 'null'] },
                plays: { type: 'integer', minimum: 0 }, publishedAt: { type: ['string', 'null'], format: 'date-time' },
                reason: { type: 'string', enum: ['similar_sound', 'artist_affinity', 'genre_affinity', 'mood_affinity', 'fresh_for_you'] },
                score: { type: 'number' },
              },
            },
          },
        },
      },
      RadioSessionRequest: {
        type: 'object', additionalProperties: false,
        properties: { mood: { type: 'string', maxLength: 50 }, genre: { type: 'string', maxLength: 100 } },
      },
      RadioSessionResponse: {
        type: 'object', required: ['id', 'status', 'startedAt', 'mood', 'context', 'schedule', 'schedulerPolicy'],
        properties: {
          id: { type: 'string', format: 'uuid' }, status: { const: 'active' },
          startedAt: { type: 'string', format: 'date-time' }, mood: { type: ['string', 'null'] },
          context: { type: 'object' }, schedule: { $ref: '#/components/schemas/RadioSchedule' },
          schedulerPolicy: { const: 'music-only-v1' },
        },
      },
      RadioSchedule: {
        type: 'object', required: ['sessionId', 'items', 'totalDurationMs', 'schedulerPolicy'],
        properties: {
          sessionId: { type: 'string', format: 'uuid' }, totalDurationMs: { type: 'integer', minimum: 0 },
          schedulerPolicy: { const: 'music-only-v1' },
          items: {
            type: 'array', items: {
              type: 'object', required: ['id', 'position', 'segmentType', 'trackId', 'durationMs', 'codec', 'contentType', 'url'],
              properties: {
                id: { type: 'string', format: 'uuid' }, position: { type: 'integer', minimum: 0 },
                segmentType: { const: 'music' }, trackId: { type: 'string', format: 'uuid' },
                durationMs: { type: 'integer', minimum: 1 }, mix: { type: 'object' },
                expiresAt: { type: 'string', format: 'date-time' }, title: { type: 'string' }, artist: { type: 'string' },
                album: { type: ['string', 'null'] }, genre: { type: ['string', 'null'] },
                mood: { type: 'array', items: { type: 'string' } }, codec: { type: 'string', enum: ['opus', 'aac', 'original'] },
                contentType: { type: 'string' }, url: { type: 'string', format: 'uri' },
                urlExpiresInSeconds: { type: 'integer', maximum: 900 }, cacheControl: { const: 'private, no-store' },
              },
            },
          },
        },
      },
      RadioSkipRequest: {
        type: 'object', additionalProperties: false, required: ['segmentId'],
        properties: { segmentId: { type: 'string', format: 'uuid' } },
      },
      RadioFeedbackRequest: {
        type: 'object', additionalProperties: false, required: ['segmentId', 'reaction'],
        properties: {
          segmentId: { type: 'string', format: 'uuid' },
          reaction: { type: 'string', enum: ['like', 'dislike', 'skip', 'report'] },
        },
      },
      VoiceRenderRequest: {
        type: 'object', additionalProperties: false, required: ['scriptId', 'voice'],
        properties: { scriptId: { type: 'string', format: 'uuid' }, voice: { type: 'string', minLength: 1, maxLength: 100 } },
      },
      VoiceRenderResponse: {
        type: 'object', required: ['cacheKey', 'provider', 'voice', 'durationMs', 'costMicrounits', 'cacheHit', 'url', 'urlExpiresInSeconds', 'cacheControl'],
        properties: {
          cacheKey: { type: 'string', pattern: '^[a-f0-9]{64}$' }, provider: { type: 'string' }, voice: { type: 'string' },
          durationMs: { type: 'integer', minimum: 1 }, costMicrounits: { type: 'string' }, cacheHit: { type: 'boolean' },
          url: { type: 'string', format: 'uri' }, urlExpiresInSeconds: { type: 'integer', maximum: 900 },
          cacheControl: { const: 'private, no-store' },
        },
      },
      TrackMediaResponse: {
        type: 'object', required: ['trackId', 'codec', 'contentType', 'url', 'expiresInSeconds', 'cacheControl'],
        properties: {
          trackId: { type: 'string', format: 'uuid' }, codec: { type: 'string', enum: ['opus', 'aac', 'original'] },
          contentType: { type: 'string' }, url: { type: 'string', format: 'uri' },
          expiresInSeconds: { type: 'integer', minimum: 1, maximum: 900 }, cacheControl: { const: 'private, no-store' },
        },
      },
      TrackPatch: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 300 }, artistDisplay: { type: 'string', minLength: 1, maxLength: 300 },
          album: { type: ['string', 'null'], maxLength: 100 }, genre: { type: ['string', 'null'], maxLength: 100 },
          mood: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 50 } },
        },
      },
      UploadIntentRequest: {
        type: 'object', additionalProperties: false,
        required: ['title', 'artistDisplay', 'contentType', 'sizeBytes'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 300 },
          artistDisplay: { type: 'string', minLength: 1, maxLength: 300 },
          contentType: { type: 'string', enum: ['audio/aac', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/opus', 'audio/wav', 'audio/webm', 'audio/x-wav'] },
          sizeBytes: { type: 'integer', minimum: 1, maximum: 209715200 },
        },
      },
      UploadIntentResponse: {
        type: 'object', required: ['uploadId', 'trackId', 'status', 'expiresAt', 'upload'],
        properties: {
          uploadId: { type: 'string', format: 'uuid' }, trackId: { type: 'string', format: 'uuid' },
          status: { const: 'pending' }, expiresAt: { type: 'string', format: 'date-time' },
          upload: {
            type: 'object', required: ['url', 'method', 'headers', 'expiresInSeconds'],
            properties: {
              url: { type: 'string', format: 'uri' }, method: { const: 'PUT' },
              headers: { type: 'object', additionalProperties: { type: 'string' } },
              expiresInSeconds: { type: 'integer', minimum: 1, maximum: 300 },
            },
          },
        },
      },
      UploadCompleteResponse: {
        type: 'object', required: ['uploadId', 'trackId', 'mediaObjectId', 'status'],
        properties: {
          uploadId: { type: 'string', format: 'uuid' }, trackId: { type: 'string', format: 'uuid' },
          mediaObjectId: { type: 'string', format: 'uuid' }, status: { const: 'queued' },
        },
      },
      PublishRequest: {
        type: 'object', additionalProperties: false, required: ['rightsConfirmed', 'offerVersion'],
        properties: { rightsConfirmed: { const: true }, offerVersion: { type: 'string', minLength: 1, maxLength: 100 } },
      },
      ModerationDecision: {
        type: 'object', additionalProperties: false, required: ['decision', 'reason'],
        properties: {
          decision: { type: 'string', enum: ['approve', 'reject', 'escalate'] },
          reason: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
      ModerationItem: {
        type: 'object', required: ['id', 'trackId', 'reason', 'status', 'createdAt', 'ownerId', 'title', 'artist'],
        properties: {
          id: { type: 'string', format: 'uuid' }, trackId: { type: 'string', format: 'uuid' },
          reason: { type: 'string' }, autoScore: { type: ['number', 'null'] },
          status: { type: 'string', enum: ['pending', 'assigned', 'escalated'] },
          assigneeId: { type: ['string', 'null'], format: 'uuid' }, createdAt: { type: 'string', format: 'date-time' },
          ownerId: { type: 'string', format: 'uuid' }, title: { type: 'string' }, artist: { type: 'string' },
          genre: { type: ['string', 'null'] }, mood: { type: 'array', items: { type: 'string' } },
          durationMs: { type: ['integer', 'null'] }, rightsConfirmedAt: { type: ['string', 'null'], format: 'date-time' },
          rightsOfferVersion: { type: ['string', 'null'] },
        },
      },
      RightsClaimRequest: {
        type: 'object', additionalProperties: false,
        required: ['trackId', 'claimantEmail', 'claimantName', 'evidenceUrl', 'claimText'],
        properties: {
          trackId: { type: 'string', format: 'uuid' }, claimantEmail: { type: 'string', format: 'email', maxLength: 254 },
          claimantName: { type: 'string', minLength: 1, maxLength: 120 },
          evidenceUrl: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048 },
          claimText: { type: 'string', minLength: 20, maxLength: 5000 },
        },
      },
      CounterNoticeRequest: {
        type: 'object', additionalProperties: false, required: ['counterNoticeText'],
        properties: { counterNoticeText: { type: 'string', minLength: 20, maxLength: 5000 } },
      },
      TrackSubmission: {
        type: 'object', required: ['id', 'status', 'visibility', 'moderation'],
        properties: {
          id: { type: 'string', format: 'uuid' }, status: { const: 'in_review' }, visibility: { const: 'private' },
          moderation: {
            type: 'object', required: ['id', 'status', 'createdAt'],
            properties: {
              id: { type: 'string', format: 'uuid' }, status: { const: 'pending' },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
      ModerationDecisionResponse: {
        type: 'object', required: ['id', 'trackId', 'status'],
        properties: {
          id: { type: 'string', format: 'uuid' }, trackId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['approved', 'rejected', 'escalated'] },
        },
      },
      RightsClaim: {
        type: 'object', required: ['id', 'trackId', 'status', 'createdAt', 'slaDueAt'],
        properties: {
          id: { type: 'string', format: 'uuid' }, trackId: { type: 'string', format: 'uuid' },
          status: { const: 'open' }, createdAt: { type: 'string', format: 'date-time' },
          slaDueAt: { type: 'string', format: 'date-time' },
        },
      },
      CounterNoticeResponse: {
        type: 'object', required: ['id', 'trackId', 'status', 'counterNoticeAt'],
        properties: {
          id: { type: 'string', format: 'uuid' }, trackId: { type: 'string', format: 'uuid' },
          status: { const: 'counter_notice' }, counterNoticeAt: { type: 'string', format: 'date-time' },
        },
      },
      RightsClaimsPage: {
        type: 'object', required: ['items'],
        properties: { items: { type: 'array', items: { $ref: '#/components/schemas/AdminRightsClaim' } } },
      },
      AdminRightsClaim: {
        type: 'object', required: [
          'id', 'trackId', 'claimantEmail', 'claimantName', 'evidenceUrl', 'claimText', 'status',
          'createdAt', 'resolvedAt', 'slaDueAt', 'counterNoticeText', 'counterNoticeAt', 'counterNoticeBy',
          'title', 'artist', 'trackStatus',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' }, trackId: { type: 'string', format: 'uuid' },
          claimantEmail: { type: ['string', 'null'], format: 'email' }, claimantName: { type: ['string', 'null'] },
          evidenceUrl: { type: ['string', 'null'], format: 'uri' }, claimText: { type: 'string' },
          status: { type: 'string', enum: ['open', 'accepted', 'rejected', 'counter_notice'] },
          createdAt: { type: 'string', format: 'date-time' },
          resolvedAt: { type: ['string', 'null'], format: 'date-time' }, slaDueAt: { type: 'string', format: 'date-time' },
          counterNoticeText: { type: ['string', 'null'] }, counterNoticeAt: { type: ['string', 'null'], format: 'date-time' },
          counterNoticeBy: { type: ['string', 'null'], format: 'uuid' }, title: { type: 'string' }, artist: { type: 'string' },
          trackStatus: { type: 'string', enum: ['quarantine', 'in_review', 'published', 'rejected', 'taken_down'] },
        },
      },
      Error: {
        type: 'object', required: ['error'], properties: {
          error: {
            type: 'object', required: ['code', 'message', 'request_id'],
            properties: { code: { type: 'string' }, message: { type: 'string' }, request_id: { type: 'string', format: 'uuid' } },
          },
        },
      },
    },
  },
};
