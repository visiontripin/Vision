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
