import { VERSION } from './lib.js';

/**
 * OpenAPI-описание контракта. Держим рядом с кодом, чтобы схема не разъезжалась
 * с реализацией: `/api/v1/openapi.json` отдаётся тем же процессом.
 */

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Vision Audio API',
    version: VERSION,
    description:
      'Личная аудиобиблиотека: загрузка, поиск, поток и обложки. ' +
      'Все приватные маршруты требуют Bearer-токен; медиа дополнительно принимает ' +
      'короткоживущую HMAC-подпись в query (её выдают /api/media).',
    license: { name: 'MIT' },
  },
  servers: [{ url: '/api/v1', description: 'Версия 1 (алиас /api)' }],
  tags: [
    { name: 'auth' },
    { name: 'tracks' },
    { name: 'media' },
    { name: 'history' },
    { name: 'playlists' },
    { name: 'external', description: 'Внешние ссылки: только метаданные, звук у источника' },
    { name: 'seeds', description: 'Трекер реплик: где лежит файл и кто его раздаёт' },
    { name: 'shares', description: 'Приватные ссылки на трек/плейлист: TTL, отзыв, статистика' },
    { name: 'embed', description: 'Встраивание: oEmbed 1.0 и виджет /embed/:token для блогов' },
    { name: 'system' },
  ],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'HMAC-SHA256' },
      mediaSignature: {
        type: 'apiKey',
        in: 'query',
        name: 'sig',
        description: 'HMAC-подпись ссылки; пара exp+sig выдаётся GET /api/media',
      },
    },
    schemas: {
      Share: {
        type: 'object',
        required: ['id', 'targetKind', 'targetId', 'plays', 'createdAt'],
        properties: {
          id: { type: 'string', pattern: '^[a-f0-9]{32}$' },
          targetKind: { type: 'string', enum: ['track', 'playlist'] },
          targetId: { type: 'string' },
          title: { type: ['string', 'null'] },
          expiresAt: { type: ['string', 'null'], format: 'date-time' },
          maxPlays: { type: ['integer', 'null'] },
          plays: { type: 'integer', description: 'Открытия страницы (не Range-запросы)' },
          revokedAt: { type: ['string', 'null'], format: 'date-time' },
          lastSeenAt: { type: ['string', 'null'], format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
          active: { type: 'boolean' },
          stats: {
            type: 'object',
            properties: {
              hits: { type: 'object', additionalProperties: { type: 'integer' }, examples: [{ open: 3, stream: 7, download: 1 }] },
              visitors: { type: 'integer', description: 'Уникальные адреса (хранятся как HMAC-хеши)' },
              lastHitAt: { type: ['string', 'null'] },
            },
          },
          baseUrl: { type: 'string' },
          comments: { type: 'integer', description: 'Сколько комментариев оставлено (только владельцу)' },
        },
      },
      ShareComment: {
        type: 'object',
        required: ['id', 'trackId', 'at', 'author', 'body', 'createdAt'],
        properties: {
          id: { type: 'string' },
          trackId: { type: 'string', description: 'Трек внутри ссылки' },
          at: { type: 'number', description: 'Секунда трека, 0..длительность' },
          author: { type: 'string', maxLength: 40 },
          body: { type: 'string', maxLength: 600 },
          createdAt: { type: 'string', format: 'date-time' },
          deletedAt: { type: ['string', 'null'], description: 'Только для владельца' },
        },
      },
      ShareWithToken: {
        allOf: [
          { $ref: '#/components/schemas/Share' },
          {
            type: 'object',
            required: ['token', 'url'],
            properties: {
              token: { type: 'string', description: 'Показывается один раз' },
              url: { type: 'string', description: 'Абсолютный адрес /s/<token>' },
              path: { type: 'string' },
            },
          },
        ],
      },
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', examples: ['unauthorized', 'duplicate', 'unsupported_type'] },
              message: { type: 'string' },
            },
          },
        },
      },
      Track: {
        type: 'object',
        required: ['id', 'title', 'artist', 'mime', 'size', 'duration', 'cover', 'plays', 'liked', 'createdAt'],
        properties: {
          id: { type: 'string', pattern: '^[a-f0-9]{32}$' },
          title: { type: 'string' },
          artist: { type: 'string' },
          album: { type: ['string', 'null'] },
          genre: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] },
          mime: { type: 'string' },
          size: { type: 'integer' },
          duration: { type: 'number' },
          peaks: {
            type: ['array', 'null'],
            items: { type: 'number', minimum: 0, maximum: 1 },
            description: 'Нормализованные пики волны; в списке отсутствуют',
          },
          cover: { type: 'boolean', description: 'Есть ли обложка (файл отдаёт /cover)' },
          plays: { type: 'integer' },
          liked: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      TrackSources: {
        type: 'object',
        description: 'Состояние реплик трека по данным трекера',
        properties: {
          hash: { type: ['string', 'null'], description: 'sha256 содержимого (null, если файла не было)' },
          local: { type: 'boolean', description: 'Файл лежит на узле, к которому обратились' },
          servable: { type: 'integer', description: 'Устройства, которые реально отдадут файл по HTTP' },
          replicas: { type: 'integer', description: 'Копии, которые есть, но раздавать не умеют' },
          devices: { type: 'integer' },
          kinds: { type: 'object', additionalProperties: { type: 'integer' } },
        },
      },
      BlobSeed: {
        type: 'object',
        properties: {
          deviceId: { type: 'string' },
          kind: { type: 'string', examples: ['origin', 'node', 'desktop', 'mobile', 'browser'] },
          baseUrl: { type: ['string', 'null'] },
          servable: { type: 'boolean' },
          onlineAt: { type: 'string', format: 'date-time' },
          ageMs: { type: 'integer' },
          url: {
            type: ['string', 'null'],
            description: 'Подписанная ссылка /seed/<hash>?exp&sig (только у раздающих)',
          },
        },
      },
      Playlist: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
          trackCount: { type: 'integer' },
          duration: { type: 'number' },
        },
      },
      HistoryEntry: {
        type: 'object',
        properties: {
          track: { $ref: '#/components/schemas/Track' },
          position: { type: 'number' },
          duration: { type: 'number' },
          completed: { type: 'boolean' },
          plays: { type: 'integer' },
          listenedAt: { type: 'string', format: 'date-time' },
        },
      },
      MediaItem: {
        type: 'object',
        properties: {
          stream: {
            type: 'string',
            description: 'Лучший доступный поток: opus → aac → оригинал',
          },
          streams: {
            type: 'object',
            description: 'Варианты по кодекам: original, opus, aac (готовые после транскодинга)',
            additionalProperties: { type: 'string' },
          },
          hls: {
            type: ['string', 'null'],
            description: 'HLS-плейлист (сегменты по 6 с) или null, если нарезки нет',
          },
          cover: { type: ['string', 'null'] },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
      ExternalTrack: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          source: { type: 'string', examples: ['soundcloud'] },
          permalink: { type: 'string', format: 'uri' },
          title: { type: 'string' },
          artist: { type: ['string', 'null'] },
          artwork: { type: ['string', 'null'] },
          embedUrl: { type: 'string', description: 'Официальный плеер источника' },
          duration: { type: 'number', description: 'Не копируется с источника, по умолчанию 0' },
          note: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Stats: {
        type: 'object',
        properties: {
          tracks: { type: 'integer' },
          plays: { type: 'integer' },
          duration: { type: 'number' },
          liked: { type: 'integer' },
          playlists: { type: 'integer' },
          bytes: { type: 'integer' },
          diskFreeMb: { type: ['integer', 'null'] },
          version: { type: 'string' },
          genres: {
            type: 'array',
            items: {
              type: 'object',
              properties: { genre: { type: 'string' }, count: { type: 'integer' } },
            },
          },
          migrations: {
            type: 'object',
            properties: {
              applied: { type: 'array', items: { type: 'string' } },
              pending: { type: 'integer' },
            },
          },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: 'Нет токена или подпись неверна',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      BadRequest: {
        description: 'Некорректные данные запроса',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Объект не найден',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NoSource: {
        description: 'no_source — файл сейчас никто не раздаёт',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            examples: { no_source: { value: { error: { code: 'no_source', message: 'Ни одно устройство сейчас не раздаёт этот файл.' } } } },
          },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['system'],
        summary: 'Состояние сервиса и миграций',
        security: [],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    tracks: { type: 'integer' },
                    diskFreeMb: { type: ['integer', 'null'] },
                    version: { type: 'string' },
                    migrations: {
                      type: 'object',
                      properties: {
                        applied: { type: 'array', items: { type: 'string' } },
                        pending: { type: 'integer' },
                      },
                    },
                    ffmpeg: {
                      type: 'object',
                      description: 'null-версия означает «бинарник не найден»; сервис работает с оригиналами',
                      properties: {
                        available: { type: 'boolean' },
                        version: { type: ['string', 'null'] },
                        path: {
                          type: ['string', 'null'],
                          description: 'Кандидат, который реально запустился: FFMPEG_PATH → ffmpeg-static → PATH',
                        },
                      },
                    },
                    runtime: {
                      type: 'object',
                      description: 'Платформа запуска; termux=true включает экономный профиль',
                      properties: {
                        platform: { type: 'string', examples: ['linux', 'android'] },
                        arch: { type: 'string' },
                        node: { type: 'string' },
                        termux: { type: 'boolean' },
                      },
                    },
                    transcode: {
                      type: 'object',
                      properties: {
                        enabled: { type: 'boolean' },
                        queued: { type: 'integer' },
                        busy: { type: 'boolean' },
                        processed: { type: 'integer' },
                        failed: { type: 'integer' },
                        lastError: { type: ['string', 'null'] },
                        settings: {
                          type: 'object',
                          properties: {
                            codecs: { type: 'array', items: { type: 'string' } },
                            hls: { type: 'boolean' },
                            normalize: { type: 'boolean' },
                            threads: { type: ['integer', 'null'] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['auth'],
        summary: 'Вход по паролю владельца',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['password'],
                properties: { password: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Токен',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    token: { type: 'string' },
                    expiresAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          429: { description: 'Слишком много попыток' },
        },
      },
    },
    '/me': {
      get: {
        tags: ['auth'],
        summary: 'Текущий владелец',
        responses: { 200: { description: 'OK' }, 401: { $ref: '#/components/responses/Unauthorized' } },
      },
    },
    '/tracks': {
      get: {
        tags: ['tracks'],
        summary: 'Список с поиском FTS5, сортировкой и пагинацией',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Полнотекстовый поиск (префиксный)' },
          { name: 'genre', in: 'query', schema: { type: 'string' } },
          { name: 'liked', in: 'query', schema: { enum: ['1'] } },
          {
            name: 'sort',
            in: 'query',
            schema: { enum: ['relevance', 'recent', 'oldest', 'title', 'plays', 'duration'], default: 'recent' },
          },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 2000, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          200: {
            description: 'Список треков',
            headers: {
              'X-Total-Count': { schema: { type: 'integer' }, description: 'Всего совпадений' },
            },
            content: {
              'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Track' } } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        tags: ['tracks'],
        summary: 'Загрузка файла (сырые байты)',
        parameters: [
          { name: 'title', in: 'query', schema: { type: 'string' } },
          { name: 'artist', in: 'query', schema: { type: 'string' } },
          { name: 'album', in: 'query', schema: { type: 'string' } },
          { name: 'genre', in: 'query', schema: { type: 'string' } },
          { name: 'description', in: 'query', schema: { type: 'string' } },
          { name: 'duration', in: 'query', schema: { type: 'number' } },
          { name: 'filename', in: 'query', schema: { type: 'string' } },
          { name: 'peaks', in: 'query', schema: { type: 'string' }, description: 'JSON-массив пиков' },
        ],
        requestBody: {
          required: true,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
        responses: {
          201: {
            description: 'Создан',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Track' } } },
          },
          409: {
            description: 'Дубликат по SHA-256',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/Error' },
                    { type: 'object', properties: { existing: { $ref: '#/components/schemas/Track' } } },
                  ],
                },
              },
            },
          },
          413: { description: 'Файл больше лимита' },
          415: { description: 'Не аудио' },
        },
      },
    },
    '/tracks/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['tracks'],
        summary: 'Полная карточка трека (с peaks)',
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Track' } } },
          },
          404: { description: 'Не найден' },
        },
      },
      patch: {
        tags: ['tracks'],
        summary: 'Правка метаданных и лайка',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  artist: { type: 'string' },
                  album: { type: ['string', 'null'] },
                  genre: { type: ['string', 'null'] },
                  description: { type: ['string', 'null'] },
                  liked: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Track' } } },
          },
        },
      },
      delete: {
        tags: ['tracks'],
        summary: 'Удалить трек вместе с файлом, обложкой и историей',
        responses: { 204: { description: 'Удалено' } },
      },
    },
    '/tracks/{id}/stream': {
      get: {
        tags: ['media'],
        summary: 'Аудиопоток с поддержкой Range',
        security: [{ bearerAuth: [] }, { mediaSignature: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'format',
            in: 'query',
            schema: { type: 'string', enum: ['original', 'opus', 'aac'] },
            description: 'Если варианта нет, сервер отдаёт оригинал (заголовок X-Variant-Fallback)',
          },
          { name: 'exp', in: 'query', schema: { type: 'integer' } },
          { name: 'sig', in: 'query', schema: { type: 'string' } },
          { name: 'Range', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Весь файл', content: { 'audio/*': { schema: { type: 'string', format: 'binary' } } } },
          206: { description: 'Часть файла (Content-Range)' },
          304: { description: 'Не изменилось (ETag)' },
          401: { $ref: '#/components/responses/Unauthorized' },
          416: { description: 'Невозможный диапазон' },
        },
      },
    },
    '/tracks/{id}/hls.m3u8': {
      get: {
        tags: ['media'],
        summary: 'HLS-плейлист (сегменты по 6 с, AAC)',
        description:
          'Требует ffmpeg. Строки-сегменты в ответе переписаны в абсолютные пути с той же подписью, '
          + 'поэтому относительное разрешение URL не ломает авторизацию.',
        security: [{ bearerAuth: [] }, { mediaSignature: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'exp', in: 'query', schema: { type: 'integer' } },
          { name: 'sig', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Плейлист', content: { 'application/vnd.apple.mpegurl': { schema: { type: 'string' } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'HLS ещё не нарезан (ffmpeg недоступен или трек в очереди)' },
        },
      },
    },
    '/tracks/{id}/hls/{segment}': {
      get: {
        tags: ['media'],
        summary: 'HLS-сегмент (MPEG-TS)',
        security: [{ bearerAuth: [] }, { mediaSignature: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'segment', in: 'path', required: true, schema: { type: 'string', examples: ['seg-000.ts'] } },
          { name: 'exp', in: 'query', schema: { type: 'integer' } },
          { name: 'sig', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Сегмент', content: { 'video/mp2t': { schema: { type: 'string', format: 'binary' } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Нет такого сегмента' },
        },
      },
    },
    '/tracks/{id}/cover': {
      get: {
        tags: ['media'],
        summary: 'Обложка трека',
        security: [{ bearerAuth: [] }, { mediaSignature: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'exp', in: 'query', schema: { type: 'integer' } },
          { name: 'sig', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Изображение', content: { 'image/*': { schema: { type: 'string', format: 'binary' } } } },
          404: { description: 'Обложки нет' },
        },
      },
      put: {
        tags: ['media'],
        summary: 'Загрузить обложку (jpeg/png/webp, ≤ 8 МБ)',
        requestBody: {
          required: true,
          content: { 'image/*': { schema: { type: 'string', format: 'binary' } } },
        },
        responses: { 204: { description: 'Сохранено' } },
      },
    },
    '/tracks/{id}/play': {
      post: {
        tags: ['tracks'],
        summary: 'Инкремент счётчика прослушиваний',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 204: { description: 'OK' } },
      },
    },
    '/tracks/{id}/listen': {
      post: {
        tags: ['history'],
        summary: 'Сохранить позицию прослушивания',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['position'],
                properties: {
                  position: { type: 'number' },
                  duration: { type: 'number' },
                  completed: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: { 204: { description: 'OK' } },
      },
    },
    '/tracks/{id}/download': {
      get: {
        tags: ['media', 'seeds'],
        summary: 'Скачать трек: локальный файл или живое устройство',
        description:
          'Отвечает 302 на подписанную ссылку сида (/seed/<hash>) либо 409 no_source, ' +
          'если файл сейчас никто не раздаёт. С ?json=1 возвращает адрес и список сидов.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'json', in: 'query', schema: { type: 'string', enum: ['1'] } },
          { name: 'exp', in: 'query', schema: { type: 'string' } },
          { name: 'sig', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          302: { description: 'Редирект на сид' },
          200: { description: 'JSON с адресом и сидами (?json=1)' },
          401: { $ref: '#/components/responses/Unauthorized' },
          409: { $ref: '#/components/responses/NoSource' },
        },
      },
    },
    '/shares': {
      post: {
        tags: ['shares'],
        summary: 'Создать приватную ссылку на трек или плейлист',
        description:
          'Токен возвращается один раз: в базе хранится только его sha256. ' +
          'Гость открывает /s/<token> без аккаунта и получает только эту цель.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['targetKind', 'targetId'],
                properties: {
                  targetKind: { type: 'string', enum: ['track', 'playlist'] },
                  targetId: { type: 'string', pattern: '^[a-f0-9]{32}$' },
                  title: { type: ['string', 'null'], description: 'Подпись владельца, не видна гостю в ссылке' },
                  ttl: {
                    type: 'string',
                    examples: ['1h', '24h', '7d', 'forever'],
                    description: 'Срок жизни; по умолчанию SHARE_DEFAULT_TTL_MS (7 дней), «forever» — бессрочно',
                  },
                  maxPlays: { type: ['integer', 'null'], description: 'Лимит открытий страницы' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Ссылка создана',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ShareWithToken' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Трек или плейлист не найден (target_not_found)' },
        },
      },
      get: {
        tags: ['shares'],
        summary: 'Все ссылки владельца (включая отозванные)',
        parameters: [
          { name: 'targetKind', in: 'query', schema: { type: 'string', enum: ['track', 'playlist'] } },
          { name: 'targetId', in: 'query', schema: { type: 'string' } },
          { name: 'includeRevoked', in: 'query', schema: { type: 'string', enum: ['1'] } },
        ],
        responses: {
          200: {
            description: 'Список без токенов (их нельзя восстановить, только перевыпустить)',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Share' } },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/shares/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['shares'],
        summary: 'Одна ссылка со статистикой',
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Share' } } } },
          404: { description: 'Не найдена' },
        },
      },
      patch: {
        tags: ['shares'],
        summary: 'Изменить подпись, срок жизни или лимит открытий',
        responses: {
          200: { description: 'Обновлённая ссылка' },
          404: { description: 'Не найдена' },
        },
      },
      delete: {
        tags: ['shares'],
        summary: 'Отозвать ссылку (?purge=1 — удалить запись и журнал)',
        parameters: [{ name: 'purge', in: 'query', schema: { type: 'string', enum: ['1'] } }],
        responses: { 204: { description: 'Отозвана' } },
      },
    },
    '/oembed': {
      get: {
        tags: ['embed'],
        summary: 'oEmbed-описание приватной ссылки (публичный, без авторизации)',
        description:
          'Принимает только адреса Vision Audio (`/s/:token` или `/embed/:token`). '
          + 'Неактивная ссылка даёт 404. Считается как встраивание: `plays` не растёт.',
        security: [],
        parameters: [
          { name: 'url', in: 'query', required: true, schema: { type: 'string' }, description: 'Ссылка /s/<токен> или /embed/<токен>' },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'xml'], default: 'json' } },
          { name: 'maxwidth', in: 'query', schema: { type: 'integer', minimum: 40, maximum: 960 } },
          { name: 'maxheight', in: 'query', schema: { type: 'integer', minimum: 40, maximum: 960 } },
        ],
        responses: {
          200: {
            description: 'Описание для встраивания',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    version: { type: 'string', example: '1.0' },
                    type: { type: 'string', example: 'rich' },
                    provider_name: { type: 'string', example: 'Vision Audio' },
                    provider_url: { type: 'string' },
                    title: { type: 'string' },
                    author_name: { type: 'string' },
                    thumbnail_url: { type: 'string' },
                    html: { type: 'string', description: '<iframe> с виджетом /embed/:token' },
                    width: { type: 'integer', example: 480 },
                    height: { type: 'integer', example: 180 },
                    vision: {
                      type: 'object',
                      properties: {
                        kind: { type: 'string', enum: ['track', 'playlist'] },
                        tracks: { type: 'integer' },
                        duration: { type: 'integer' },
                      },
                    },
                  },
                },
              },
              'text/xml': { schema: { type: 'string' } },
            },
          },
          400: { description: '`invalid_url` — чужой адрес, `invalid_format` — не json/xml' },
          404: { description: '`not_found` — ссылка отозвана, истекла или не существует' },
        },
      },
    },
    '/shares/{id}/rotate': {
      post: {
        tags: ['shares'],
        summary: 'Перевыпустить токен: старая ссылка сразу отвечает 410',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Новый токен (единственный раз)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ShareWithToken' } } },
          },
          404: { description: 'Не найдена' },
        },
      },
    },
    '/shares/{id}/comments': {
      get: {
        tags: ['shares'],
        summary: 'Комментарии к секундам по ссылке (владелец видит и удалённые)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'trackId', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'Лента',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    comments: { type: 'array', items: { $ref: '#/components/schemas/ShareComment' } },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Ссылка не найдена' },
        },
      },
      post: {
        tags: ['shares'],
        summary: 'Владелец отмечает секунду — комментарий увидят гости',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['trackId', 'body'],
                properties: {
                  trackId: { type: 'string' },
                  at: { type: 'number' },
                  author: { type: 'string' },
                  body: { type: 'string', maxLength: 600 },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Создан',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ShareComment' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { description: 'Трек не входит в ссылку' },
        },
      },
      delete: {
        tags: ['shares'],
        summary: 'Удалить комментарий (владелец — любой)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'commentId', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Удалён' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Комментарий не найден' },
        },
      },
    },
    '/blobs': {
      post: {
        tags: ['seeds'],
        summary: 'Объявить блоб (содержимое по sha256)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['hash'],
                properties: {
                  hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                  bytes: { type: 'integer' },
                  mime: { type: 'string' },
                  deviceId: { type: 'string' },
                  kind: { type: 'string' },
                  baseUrl: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Блоб объявлен, сид зарегистрирован (если передан)' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/blobs/{hash}': {
      get: {
        tags: ['seeds'],
        summary: 'Состояние блоба и его сиды',
        description:
          'Отдаёт blob, local, seeded (файл лежит в каталоге сида этого узла), deviceId узла, ' +
          'seeds и stats.',
        parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'OK' },
          404: { description: 'Блоб неизвестен' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
      delete: {
        tags: ['seeds'],
        summary: 'Забыть блоб',
        parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 204: { description: 'OK' }, 401: { $ref: '#/components/responses/Unauthorized' } },
      },
    },
    '/blobs/{hash}/seeds': {
      get: {
        tags: ['seeds'],
        summary: 'Живые сиды блоба с подписанными ссылками',
        parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    hash: { type: 'string' },
                    ttlMs: { type: 'integer', description: 'Срок жизни heartbeat сида' },
                    local: { type: 'boolean' },
                    stats: { type: 'object' },
                    seeds: { type: 'array', items: { $ref: '#/components/schemas/BlobSeed' } },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/blobs/{hash}/seed': {
      post: {
        tags: ['seeds'],
        summary: 'Heartbeat: «я раздаю этот файл»',
        parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  deviceId: { type: 'string' },
                  kind: { type: 'string', enum: ['origin', 'node', 'desktop', 'mobile', 'browser'] },
                  baseUrl: { type: 'string', description: 'Обязателен для origin/node/desktop' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Сид обновлён' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
      delete: {
        tags: ['seeds'],
        summary: 'Убрать устройство из реестра',
        parameters: [
          { name: 'hash', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'deviceId', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 204: { description: 'OK' }, 401: { $ref: '#/components/responses/Unauthorized' } },
      },
    },
    '/blobs/{hash}/replicate': {
      post: {
        tags: ['seeds'],
        summary: 'Забрать файл с живого сида на этот узел',
        description: 'Скачивает блоб, сверяет sha256 и начинает раздавать его сам.',
        parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Реплика создана (или уже была)' },
          409: { $ref: '#/components/responses/NoSource' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/blobs/{hash}/replica': {
      delete: {
        tags: ['seeds'],
        summary: 'Удалить локальную реплику блоба',
        description:
          'Убирает файл из каталога сида и снимает свой сид с реестра трекера. ' +
          'Origin-файлы из хранилища не трогает; чужой сид не снимается.',
        parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          204: { description: 'Реплика удалена' },
          404: {
            description: 'not_a_replica — локальной реплики нет (origin-файл или файла нет вовсе)',
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/seeds': {
      get: {
        tags: ['seeds'],
        summary: 'Сводка трекера этого узла',
        responses: { 200: { description: 'Блобы, сиды, треки без источника' } },
      },
    },
    '/media': {
      get: {
        tags: ['media'],
        summary: 'Подписанные ссылки на поток и обложки',
        parameters: [
          {
            name: 'ids',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'До 200 идентификаторов через запятую',
          },
        ],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ttlMs: { type: 'integer' },
                    items: {
                      type: 'object',
                      additionalProperties: { $ref: '#/components/schemas/MediaItem' },
                    },
                  },
                },
              },
            },
          },
          400: { description: 'Нет валидных ids' },
        },
      },
    },
    '/history': {
      get: {
        tags: ['history'],
        summary: 'Последние прослушивания',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 12, maximum: 100 } }],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/HistoryEntry' } },
              },
            },
          },
        },
      },
      delete: {
        tags: ['history'],
        summary: 'Очистить историю',
        responses: { 204: { description: 'OK' } },
      },
    },
    '/playlists': {
      get: {
        tags: ['playlists'],
        summary: 'Список плейлистов',
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Playlist' } },
              },
            },
          },
        },
      },
      post: {
        tags: ['playlists'],
        summary: 'Создать плейлист',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' }, description: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Создан',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Playlist' } } },
          },
        },
      },
    },
    '/playlists/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      patch: {
        tags: ['playlists'],
        summary: 'Переименовать',
        responses: { 200: { description: 'OK' } },
      },
      delete: {
        tags: ['playlists'],
        summary: 'Удалить плейлист',
        responses: { 204: { description: 'OK' } },
      },
    },
    '/playlists/{id}/tracks': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['playlists'],
        summary: 'Треки плейлиста',
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Track' } },
              },
            },
          },
        },
      },
      post: {
        tags: ['playlists'],
        summary: 'Добавить трек',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['trackId'], properties: { trackId: { type: 'string' } } },
            },
          },
        },
        responses: { 204: { description: 'OK' } },
      },
    },
    '/playlists/{id}/tracks/{trackId}': {
      delete: {
        tags: ['playlists'],
        summary: 'Убрать трек из плейлиста',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'trackId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 204: { description: 'OK' } },
      },
    },
    '/external': {
      get: {
        tags: ['external'],
        summary: 'Закладки на внешние треки (метаданные и официальный плеер)',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 200, maximum: 500 } }],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/ExternalTrack' } },
              },
            },
          },
        },
      },
      post: {
        tags: ['external'],
        summary: 'Импорт ссылок SoundCloud через официальный oEmbed (аудио не скачивается)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['urls'],
                properties: {
                  urls: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uri' } },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Что добавилось и что не получилось',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    added: { type: 'array', items: { $ref: '#/components/schemas/ExternalTrack' } },
                    failed: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          url: { type: 'string' },
                          code: { type: 'string' },
                          message: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: { description: 'Ни одной ссылки не удалось добавить' },
        },
      },
    },
    '/external/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      patch: {
        tags: ['external'],
        summary: 'Заметка к ссылке',
        responses: { 200: { description: 'OK' } },
      },
      delete: {
        tags: ['external'],
        summary: 'Удалить закладку',
        responses: { 204: { description: 'OK' } },
      },
    },
    '/stats': {
      get: {
        tags: ['system'],
        summary: 'Статистика библиотеки',
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Stats' } } },
          },
        },
      },
    },
  },
};
