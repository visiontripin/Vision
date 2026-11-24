export interface paths {
    "/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Лента журнала действий (новые сверху) */
        get: {
            parameters: {
                query?: {
                    /** @description Код действия или группа: `track` → все `track.*` */
                    action?: string;
                    actor?: "owner" | "guest" | "system";
                    limit?: number;
                    offset?: number;
                    shareId?: string;
                    since?: string;
                    until?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Записи журнала и словарь подписей */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            actors?: {
                                [key: string]: string;
                            };
                            entries?: {
                                action?: string;
                                actor?: string;
                                /** Format: date-time */
                                at?: string;
                                details?: Record<string, never> | null;
                                id?: number;
                                /** @description sha256(secret + ip) */
                                ipHash?: string | null;
                                /** @description готовая подпись на русском */
                                label?: string;
                                /** @description совпадает с X-Request-Id */
                                requestId?: string | null;
                                shareId?: string | null;
                                targetId?: string | null;
                                targetKind?: string | null;
                            }[];
                            labels?: {
                                [key: string]: string;
                            };
                            limit?: number;
                            offset?: number;
                            retentionDays?: number;
                            total?: number;
                        };
                    };
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        put?: never;
        post?: never;
        /** Удалить записи старше keepDays */
        delete: {
            parameters: {
                query?: {
                    keepDays?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description `{ removed, before }` */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/audit/actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Справочник действий и подписей */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description `{ actions: [{ code, label, actor, target }], actors, retentionDays }` */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/audit/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Сводка за период: сколько действий по акторам */
        get: {
            parameters: {
                query?: {
                    days?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description `{ since, total, byActor, actions }` */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Вход по паролю владельца */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        password: string;
                    };
                };
            };
            responses: {
                /** @description Токен */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            expiresAt?: string;
                            token?: string;
                        };
                    };
                };
                401: components["responses"]["Unauthorized"];
                /** @description Слишком много попыток */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/backups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Состояние резервных копий (D5) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BackupStatus"];
                    };
                };
                /** @description Только владелец */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        /**
         * Создать копию и сразу проверить её
         * @description Красная проверка не ошибка запроса: архив создан, об этом говорит `ok: false`.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Копия создана (проверка внутри) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BackupVerification"];
                    };
                };
                /** @description Только владелец */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Только GET/POST */
                405: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/backups/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Проверить восстановление из архива */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description По умолчанию — последняя копия */
                        name?: string;
                    };
                };
            };
            responses: {
                /** @description Результат проверки */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BackupVerification"];
                    };
                };
                /** @description Имя не похоже на копию (параметр не путь) */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Копий ещё нет */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/blobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Объявить блоб (содержимое по sha256) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        baseUrl?: string;
                        bytes?: number;
                        deviceId?: string;
                        hash: string;
                        kind?: string;
                        mime?: string;
                    };
                };
            };
            responses: {
                /** @description Блоб объявлен, сид зарегистрирован (если передан) */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthorized"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/blobs/{hash}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Состояние блоба и его сиды
         * @description Отдаёт blob, local, seeded (файл лежит в каталоге сида этого узла), deviceId узла, seeds и stats.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    hash: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
                /** @description Блоб неизвестен */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        /** Забыть блоб */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    hash: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/blobs/{hash}/replica": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Удалить локальную реплику блоба
         * @description Убирает файл из каталога сида и снимает свой сид с реестра трекера. Origin-файлы из хранилища не трогает; чужой сид не снимается.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    hash: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Реплика удалена */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
                /** @description not_a_replica — локальной реплики нет (origin-файл или файла нет вовсе) */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/blobs/{hash}/replicate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Забрать файл с живого сида на этот узел
         * @description Скачивает блоб, сверяет sha256 и начинает раздавать его сам.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    hash: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Реплика создана (или уже была) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
                409: components["responses"]["NoSource"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/blobs/{hash}/seed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Heartbeat: «я раздаю этот файл» */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    hash: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description Обязателен для origin/node/desktop */
                        baseUrl?: string;
                        deviceId?: string;
                        /** @enum {string} */
                        kind?: "origin" | "node" | "desktop" | "mobile" | "browser";
                    };
                };
            };
            responses: {
                /** @description Сид обновлён */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthorized"];
            };
        };
        /** Убрать устройство из реестра */
        delete: {
            parameters: {
                query?: {
                    deviceId?: string;
                };
                header?: never;
                path: {
                    hash: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/blobs/{hash}/seeds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Живые сиды блоба с подписанными ссылками */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    hash: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            hash?: string;
                            local?: boolean;
                            seeds?: components["schemas"]["BlobSeed"][];
                            stats?: Record<string, never>;
                            /** @description Срок жизни heartbeat сида */
                            ttlMs?: number;
                        };
                    };
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/crashes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Лента отчётов о падениях */
        get: {
            parameters: {
                query?: {
                    app?: "mobile" | "web" | "desktop" | "console";
                    limit?: number;
                    offset?: number;
                    version?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items?: components["schemas"]["CrashItem"][];
                            limit?: number;
                            offset?: number;
                            total?: number;
                        };
                    };
                };
                /** @description Только владелец */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Метод не поддерживается */
                405: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        /**
         * Отчёт о падении приложения (H5)
         * @description Без токена осознанно: приложение падает и до входа, и после истечения сессии. Защита — размер тела (16 КБ) и лимит по установке (60 разных падений в час). Повтор с тем же fingerprint не создаёт запись, а увеличивает `count`.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["CrashReport"];
                };
            };
            responses: {
                /** @description Принят (возможно, как повтор) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            accepted?: boolean;
                            /** @description Сколько раз повторилось */
                            count?: number;
                            /** @description Такое падение уже было */
                            duplicate?: boolean;
                        };
                    };
                };
                /** @description Не JSON — `invalid_json` */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Больше 16 КБ — `too_large` */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Слишком много разных падений с одной установки за час */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            accepted?: boolean;
                            /** @enum {string} */
                            reason?: "rate_limited";
                        };
                    };
                };
            };
        };
        /**
         * Чистка старых отчётов
         * @description Пишет действие `crashes.prune` в журнал. По умолчанию хранит 90 дней.
         */
        delete: {
            parameters: {
                query?: {
                    keepDays?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            before?: string;
                            removed?: number;
                        };
                    };
                };
                /** @description Только владелец */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/crashes/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Сводка: группы, события, установки, версии */
        get: {
            parameters: {
                query?: {
                    days?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            byApp?: Record<string, never>[];
                            byVersion?: Record<string, never>[];
                            days?: number;
                            devices?: number;
                            events?: number;
                            groups?: number;
                            hint?: string | null;
                            since?: string;
                        };
                    };
                };
                /** @description Только владелец */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dashboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Прослушивания по дням, топ-треки, источники (D1) */
        get: {
            parameters: {
                query?: {
                    days?: number;
                    /** @description Смещение в минутах; по умолчанию — смещение сервера */
                    tz?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Dashboard"];
                    };
                };
                /** @description Только владелец */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Только GET */
                405: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/external": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Закладки на внешние треки (метаданные и официальный плеер) */
        get: {
            parameters: {
                query?: {
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ExternalTrack"][];
                    };
                };
            };
        };
        put?: never;
        /** Импорт ссылок SoundCloud через официальный oEmbed (аудио не скачивается) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        urls: string[];
                    };
                };
            };
            responses: {
                /** @description Что добавилось и что не получилось */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            added?: components["schemas"]["ExternalTrack"][];
                            failed?: {
                                code?: string;
                                message?: string;
                                url?: string;
                            }[];
                        };
                    };
                };
                /** @description Ни одной ссылки не удалось добавить */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/external/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Удалить закладку */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        /** Заметка к ссылке */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Состояние сервиса и миграций */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            diskFreeMb?: number | null;
                            /** @description null-версия означает «бинарник не найден»; сервис работает с оригиналами */
                            ffmpeg?: {
                                available?: boolean;
                                /** @description Кандидат, который реально запустился: FFMPEG_PATH → ffmpeg-static → PATH */
                                path?: string | null;
                                version?: string | null;
                            };
                            migrations?: {
                                applied?: string[];
                                pending?: number;
                            };
                            ok?: boolean;
                            /** @description Платформа запуска; termux=true включает экономный профиль */
                            runtime?: {
                                arch?: string;
                                node?: string;
                                /**
                                 * @example linux
                                 * @example android
                                 */
                                platform?: string;
                                termux?: boolean;
                            };
                            security?: {
                                mediaSecretConfigured?: boolean;
                            };
                            tracks?: number;
                            transcode?: {
                                busy?: boolean;
                                enabled?: boolean;
                                failed?: number;
                                lastError?: string | null;
                                processed?: number;
                                queued?: number;
                                settings?: {
                                    codecs?: string[];
                                    hls?: boolean;
                                    normalize?: boolean;
                                    threads?: number | null;
                                };
                            };
                            version?: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Последние прослушивания */
        get: {
            parameters: {
                query?: {
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HistoryEntry"][];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** Очистить историю */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Текущий владелец */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Подписанные ссылки на поток и обложки */
        get: {
            parameters: {
                query: {
                    /** @description До 200 идентификаторов через запятую */
                    ids: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items?: {
                                [key: string]: components["schemas"]["MediaItem"];
                            };
                            ttlMs?: number;
                        };
                    };
                };
                /** @description Нет валидных ids */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/oembed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * oEmbed-описание приватной ссылки (публичный, без авторизации)
         * @description Принимает только адреса Vision Audio (`/s/:token` или `/embed/:token`). Неактивная ссылка даёт 404. Считается как встраивание: `plays` не растёт.
         */
        get: {
            parameters: {
                query: {
                    format?: "json" | "xml";
                    maxheight?: number;
                    maxwidth?: number;
                    /** @description Ссылка /s/<токен> или /embed/<токен> */
                    url: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Описание для встраивания */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            author_name?: string;
                            /** @example 180 */
                            height?: number;
                            /** @description <iframe> с виджетом /embed/:token */
                            html?: string;
                            /** @example Vision Audio */
                            provider_name?: string;
                            provider_url?: string;
                            thumbnail_url?: string;
                            title?: string;
                            /** @example rich */
                            type?: string;
                            /** @example 1.0 */
                            version?: string;
                            vision?: {
                                duration?: number;
                                /** @enum {string} */
                                kind?: "track" | "playlist";
                                tracks?: number;
                            };
                            /** @example 480 */
                            width?: number;
                        };
                        "text/xml": string;
                    };
                };
                /** @description `invalid_url` — чужой адрес, `invalid_format` — не json/xml */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description `not_found` — ссылка отозвана, истекла или не существует */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/personal": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Подборки по истории прослушиваний (J3) */
        get: {
            parameters: {
                query?: {
                    limit?: number;
                    /** @description Фиксирует перемешивание; по умолчанию — номер дня */
                    seed?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PersonalFeed"];
                    };
                };
                /** @description Только владелец: подборки строятся по его истории */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/playlists": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Список плейлистов */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Playlist"][];
                    };
                };
            };
        };
        put?: never;
        /** Создать плейлист */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        description?: string;
                        name: string;
                    };
                };
            };
            responses: {
                /** @description Создан */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Playlist"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/playlists/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Удалить плейлист */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        /** Переименовать */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        trace?: never;
    };
    "/playlists/{id}/tracks": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        /** Треки плейлиста */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Track"][];
                    };
                };
            };
        };
        put?: never;
        /** Добавить трек */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        trackId: string;
                    };
                };
            };
            responses: {
                /** @description OK */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/playlists/{id}/tracks/{trackId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Убрать трек из плейлиста */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    trackId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/seeds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Сводка трекера этого узла */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Блобы, сиды, треки без источника */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/setup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Проверить первичную настройку владельца Vision Server
         * @description Только loopback; доступен, если задан VISION_PASSWORD_FILE. Остальной API до настройки пароля возвращает 503.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Состояние первоначальной настройки */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            configured: boolean;
                        };
                    };
                };
                /** @description Запрос не пришёл с loopback или Origin не разрешён */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Режим первичной настройки выключен */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        /**
         * Один раз задать пароль владельца Vision Server
         * @description Только loopback и только если владелец ещё не настроен. Пароль сохраняется как salted scrypt-хеш.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        password: string;
                    };
                };
            };
            responses: {
                /** @description Пароль владельца сохранён */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            configured: boolean;
                        };
                    };
                };
                /** @description Пароль некорректен */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Запрос не пришёл с loopback или Origin не разрешён */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Режим первичной настройки выключен */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Пароль владельца уже задан */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/shares": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Все ссылки владельца (включая отозванные) */
        get: {
            parameters: {
                query?: {
                    includeRevoked?: "1";
                    targetId?: string;
                    targetKind?: "track" | "playlist";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Список без токенов (их нельзя восстановить, только перевыпустить) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Share"][];
                    };
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        put?: never;
        /**
         * Создать приватную ссылку на трек или плейлист
         * @description Токен возвращается один раз: в базе хранится только его sha256. Гость открывает /s/<token> без аккаунта и получает только эту цель.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @description Лимит открытий страницы */
                        maxPlays?: number | null;
                        targetId: string;
                        /** @enum {string} */
                        targetKind: "track" | "playlist";
                        /** @description Подпись владельца, не видна гостю в ссылке */
                        title?: string | null;
                        /**
                         * @description Срок жизни; по умолчанию SHARE_DEFAULT_TTL_MS (7 дней), «forever» — бессрочно
                         * @example 1h
                         * @example 24h
                         * @example 7d
                         * @example forever
                         */
                        ttl?: string;
                    };
                };
            };
            responses: {
                /** @description Ссылка создана */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ShareWithToken"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthorized"];
                /** @description Трек или плейлист не найден (target_not_found) */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/shares/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        /** Одна ссылка со статистикой */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Share"];
                    };
                };
                /** @description Не найдена */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        /** Отозвать ссылку (?purge=1 — удалить запись и журнал) */
        delete: {
            parameters: {
                query?: {
                    purge?: "1";
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Отозвана */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        /** Изменить подпись, срок жизни или лимит открытий */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Обновлённая ссылка */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Не найдена */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        trace?: never;
    };
    "/shares/{id}/comments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Комментарии к секундам по ссылке (владелец видит и удалённые) */
        get: {
            parameters: {
                query?: {
                    trackId?: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Лента */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            comments?: components["schemas"]["ShareComment"][];
                            total?: number;
                        };
                    };
                };
                401: components["responses"]["Unauthorized"];
                /** @description Ссылка не найдена */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        /** Владелец отмечает секунду — комментарий увидят гости */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        at?: number;
                        author?: string;
                        body: string;
                        trackId: string;
                    };
                };
            };
            responses: {
                /** @description Создан */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ShareComment"];
                    };
                };
                400: components["responses"]["BadRequest"];
                401: components["responses"]["Unauthorized"];
                /** @description Трек не входит в ссылку */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        /** Удалить комментарий (владелец — любой) */
        delete: {
            parameters: {
                query: {
                    commentId: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Удалён */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
                /** @description Комментарий не найден */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/shares/{id}/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Перевыпустить токен: старая ссылка сразу отвечает 410 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Новый токен (единственный раз) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ShareWithToken"];
                    };
                };
                /** @description Не найдена */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/shutdown": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Штатная остановка процесса сервера
         * @description Только владелец с Bearer-токеном. Используется менеджером локального процесса; сервер завершает работу после ответа.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Сервер принял запрос на остановку */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            ok?: boolean;
                            stopping?: boolean;
                        };
                    };
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/smart-playlists": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Список умных плейлистов */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SmartPlaylist"][];
                    };
                };
            };
        };
        put?: never;
        /** Создать умный плейлист */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        description?: string;
                        name: string;
                        rules: components["schemas"]["SmartRules"];
                    };
                };
            };
            responses: {
                /** @description Создан */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SmartPlaylist"];
                    };
                };
                /** @description Правила не разбираются (invalid_rules, unknown_field, unknown_op, invalid_value) */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/smart-playlists/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        /** Умный плейлист */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Не найден */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        /** Удалить */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        /** Изменить правила или название */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Правила не разбираются */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        trace?: never;
    };
    "/smart-playlists/{id}/tracks": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        /** Треки, подходящие под правила (до limit из правил) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK, X-Total-Count — все совпадения */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Track"][];
                    };
                };
                /** @description Правила в базе не разбираются */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Статистика библиотеки */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Stats"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tracks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Список с поиском FTS5, сортировкой и пагинацией */
        get: {
            parameters: {
                query?: {
                    genre?: string;
                    liked?: "1";
                    limit?: number;
                    offset?: number;
                    /** @description Полнотекстовый поиск (префиксный) */
                    q?: string;
                    sort?: "relevance" | "recent" | "oldest" | "title" | "plays" | "duration";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Список треков */
                200: {
                    headers: {
                        /** @description Всего совпадений */
                        "X-Total-Count"?: number;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Track"][];
                    };
                };
                401: components["responses"]["Unauthorized"];
            };
        };
        put?: never;
        /** Загрузка файла (сырые байты) */
        post: {
            parameters: {
                query?: {
                    album?: string;
                    artist?: string;
                    description?: string;
                    duration?: number;
                    filename?: string;
                    genre?: string;
                    /** @description JSON-массив пиков */
                    peaks?: string;
                    title?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/octet-stream": string;
                };
            };
            responses: {
                /** @description Создан */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Track"];
                    };
                };
                /** @description Дубликат по SHA-256 */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Error"] & {
                            existing?: components["schemas"]["Track"];
                        };
                    };
                };
                /** @description Файл больше лимита */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Не аудио */
                415: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tracks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        /** Полная карточка трека (с peaks) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Track"];
                    };
                };
                /** @description Не найден */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        /** Удалить трек вместе с файлом, обложкой и историей */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Удалено */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        /** Правка метаданных и лайка */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        album?: string | null;
                        artist?: string;
                        description?: string | null;
                        genre?: string | null;
                        liked?: boolean;
                        title?: string;
                    };
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Track"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/tracks/{id}/cover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Обложка трека */
        get: {
            parameters: {
                query?: {
                    exp?: number;
                    sig?: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Изображение */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "image/*": string;
                    };
                };
                /** @description Обложки нет */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        /** Загрузить обложку (jpeg/png/webp, ≤ 8 МБ) */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "image/*": string;
                };
            };
            responses: {
                /** @description Сохранено */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tracks/{id}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Скачать трек: локальный файл или живое устройство
         * @description Отвечает 302 на подписанную ссылку сида (/seed/<hash>) либо 409 no_source, если файл сейчас никто не раздаёт. С ?json=1 возвращает адрес и список сидов.
         */
        get: {
            parameters: {
                query?: {
                    exp?: string;
                    json?: "1";
                    sig?: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description JSON с адресом и сидами (?json=1) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Редирект на сид */
                302: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
                409: components["responses"]["NoSource"];
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tracks/{id}/hls.m3u8": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * HLS-плейлист (сегменты по 6 с, AAC)
         * @description Требует ffmpeg. Строки-сегменты в ответе переписаны в абсолютные пути с той же подписью, поэтому относительное разрешение URL не ломает авторизацию.
         */
        get: {
            parameters: {
                query?: {
                    exp?: number;
                    sig?: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Плейлист */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/vnd.apple.mpegurl": string;
                    };
                };
                401: components["responses"]["Unauthorized"];
                /** @description HLS ещё не нарезан (ffmpeg недоступен или трек в очереди) */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tracks/{id}/hls/{segment}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** HLS-сегмент (MPEG-TS) */
        get: {
            parameters: {
                query?: {
                    exp?: number;
                    sig?: string;
                };
                header?: never;
                path: {
                    id: string;
                    segment: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Сегмент */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "video/mp2t": string;
                    };
                };
                401: components["responses"]["Unauthorized"];
                /** @description Нет такого сегмента */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tracks/{id}/listen": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Сохранить позицию прослушивания */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        completed?: boolean;
                        duration?: number;
                        position: number;
                    };
                };
            };
            responses: {
                /** @description OK */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tracks/{id}/play": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Инкремент счётчика прослушиваний */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tracks/{id}/stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Аудиопоток с поддержкой Range */
        get: {
            parameters: {
                query?: {
                    exp?: number;
                    /** @description Если варианта нет, сервер отдаёт оригинал (заголовок X-Variant-Fallback) */
                    format?: "original" | "opus" | "aac";
                    sig?: string;
                };
                header?: {
                    Range?: string;
                };
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Весь файл */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "audio/*": string;
                    };
                };
                /** @description Часть файла (Content-Range) */
                206: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Не изменилось (ETag) */
                304: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                401: components["responses"]["Unauthorized"];
                /** @description Невозможный диапазон */
                416: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        BackupStatus: {
            ageDays?: number | null;
            backups?: Record<string, never>[];
            count?: number;
            dir?: string;
            hint?: string | null;
            keep?: number;
            last?: {
                bytes?: number;
                /** Format: date-time */
                createdAt?: string;
                name?: string;
            } | null;
            /** @enum {string} */
            level?: "ok" | "warn";
            schedule?: {
                hours?: number;
                lastRun?: Record<string, never> | null;
                running?: boolean;
            };
            totalBytes?: number;
        };
        BackupVerification: {
            archive?: string;
            /** Format: date-time */
            checkedAt?: string;
            checkedFiles?: number;
            counts?: {
                [key: string]: number | null;
            };
            missingFiles?: string[];
            ok?: boolean;
            problems?: string[];
        };
        BlobSeed: {
            ageMs?: number;
            baseUrl?: string | null;
            deviceId?: string;
            /**
             * @example origin
             * @example node
             * @example desktop
             * @example mobile
             * @example browser
             */
            kind?: string;
            /** Format: date-time */
            onlineAt?: string;
            servable?: boolean;
            /** @description Подписанная ссылка /seed/<hash>?exp&sig (только у раздающих) */
            url?: string | null;
        };
        CrashItem: {
            app?: string;
            context?: Record<string, never> | string | null;
            /** @description Сколько раз повторилось */
            count?: number;
            deviceId?: string | null;
            /** @description `name:message:первый кадр` — по нему схлопываются повторы */
            fingerprint?: string;
            /** Format: date-time */
            firstAt?: string;
            id?: number;
            /** Format: date-time */
            lastAt?: string;
            message?: string | null;
            name?: string | null;
            platform?: string | null;
            release?: string | null;
            stack?: string | null;
            version?: string | null;
        };
        /** @description То, что присылает упавший клиент. Всё, кроме `name`/`message`, необязательно. */
        CrashReport: {
            /**
             * @default mobile
             * @enum {string}
             */
            app: "mobile" | "web" | "desktop" | "console";
            /** @description Где были: экран, режим. До 2000 символов JSON */
            context?: Record<string, never>;
            /** @description Идентификатор установки (не адрес), до 80 символов */
            deviceId?: string;
            /** @description Сообщение, обрезается до 500 символов */
            message?: string;
            /** @description Тип ошибки, до 120 символов */
            name?: string;
            /** @description android / ios / web / windows */
            platform?: string;
            /** @description Версия ОС или строка сборки */
            release?: string;
            /** @description Стек, обрезается до 6000 символов */
            stack?: string;
            /** @description Версия сборки, до 40 символов */
            version?: string;
        };
        Dashboard: {
            /** @description Все дни окна, включая пустые: в графике не должно быть «дыр» */
            byDay?: {
                completed?: number;
                /** @description YYYY-MM-DD */
                day?: string;
                plays?: number;
                shared?: number;
            }[];
            days?: number;
            hint?: string | null;
            /** @description Отпечатки адресов (начало sha256), а не сами адреса */
            listeners?: {
                /** Format: date-time */
                firstSeen?: string;
                id?: string;
                /** Format: date-time */
                lastSeen?: string;
                plays?: number;
                tracks?: number;
            }[];
            /** Format: date-time */
            since?: string;
            sources?: {
                owner?: number;
                share?: number;
            };
            topTracks?: {
                artist?: string | null;
                completed?: number;
                /** @description Трек удалён, история сохранена */
                deleted?: boolean;
                id?: string;
                plays?: number;
                title?: string | null;
            }[];
            totals?: {
                completed?: number;
                listeners?: number;
                plays?: number;
                sharedPlays?: number;
                tracks?: number;
            };
            /** @description Смещение сервера в минутах: «день» — день человека */
            tz?: number;
            /** Format: date-time */
            until?: string;
        };
        Error: {
            error: {
                /**
                 * @example unauthorized
                 * @example duplicate
                 * @example unsupported_type
                 */
                code: string;
                message: string;
            };
        };
        ExternalTrack: {
            artist?: string | null;
            artwork?: string | null;
            /** Format: date-time */
            createdAt?: string;
            /** @description Не копируется с источника, по умолчанию 0 */
            duration?: number;
            /** @description Официальный плеер источника */
            embedUrl?: string;
            id?: string;
            note?: string | null;
            /** Format: uri */
            permalink?: string;
            /** @example soundcloud */
            source?: string;
            title?: string;
        };
        HistoryEntry: {
            completed?: boolean;
            duration?: number;
            /** Format: date-time */
            listenedAt?: string;
            plays?: number;
            position?: number;
            track?: components["schemas"]["Track"];
        };
        MediaItem: {
            cover?: string | null;
            /** Format: date-time */
            expiresAt?: string;
            /** @description HLS-плейлист (сегменты по 6 с) или null, если нарезки нет */
            hls?: string | null;
            /** @description Лучший доступный поток: opus → aac → оригинал */
            stream?: string;
            /** @description Варианты по кодекам: original, opus, aac (готовые после транскодинга) */
            streams?: {
                [key: string]: string;
            };
        };
        PersonalFeed: {
            /** Format: date-time */
            generatedAt?: string;
            /** @description Доброе утро / день / вечер по времени сервера */
            greeting?: string;
            /** @description Заполнено, когда подборок нет */
            hint?: string | null;
            libraryTracks?: number;
            sections?: components["schemas"]["PersonalSection"][];
            /** @description Фиксирует перемешивание до конца дня */
            seed?: number;
        };
        PersonalSection: {
            /** @enum {string} */
            key?: "continue" | "top-genre" | "forgotten" | "fresh" | "liked-mix";
            /** @description Почему эти треки здесь */
            reason?: string;
            title?: string;
            tracks?: components["schemas"]["Track"][];
        };
        Playlist: {
            /** Format: date-time */
            createdAt?: string;
            description?: string | null;
            duration?: number;
            id?: string;
            name?: string;
            trackCount?: number;
        };
        Share: {
            active?: boolean;
            baseUrl?: string;
            /** @description Сколько комментариев оставлено (только владельцу) */
            comments?: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            expiresAt?: string | null;
            id: string;
            /** Format: date-time */
            lastSeenAt?: string | null;
            maxPlays?: number | null;
            /** @description Открытия страницы (не Range-запросы) */
            plays: number;
            /** Format: date-time */
            revokedAt?: string | null;
            stats?: {
                /**
                 * @example {
                 *       "open": 3,
                 *       "stream": 7,
                 *       "download": 1
                 *     }
                 */
                hits?: {
                    [key: string]: number;
                };
                lastHitAt?: string | null;
                /** @description Уникальные адреса (хранятся как HMAC-хеши) */
                visitors?: number;
            };
            targetId: string;
            /** @enum {string} */
            targetKind: "track" | "playlist";
            title?: string | null;
        };
        ShareComment: {
            /** @description Секунда трека, 0..длительность */
            at: number;
            author: string;
            body: string;
            /** Format: date-time */
            createdAt: string;
            /** @description Только для владельца */
            deletedAt?: string | null;
            id: string;
            /** @description Трек внутри ссылки */
            trackId: string;
        };
        ShareWithToken: components["schemas"]["Share"] & {
            path?: string;
            /** @description Показывается один раз */
            token: string;
            /** @description Абсолютный адрес /s/<token> */
            url: string;
        };
        SmartPlaylist: {
            /** Format: date-time */
            createdAt?: string;
            description?: string | null;
            id?: string;
            name?: string;
            rules?: components["schemas"]["SmartRules"];
            /** @enum {boolean} */
            smart?: true;
            /** @description Подписи правил по-русски */
            summary?: string;
            /** @description Сколько треков подходит под правила сейчас */
            trackCount?: number;
            /** Format: date-time */
            updatedAt?: string;
        };
        SmartRule: {
            /** @enum {string} */
            field: "genre" | "artist" | "album" | "title" | "liked" | "year" | "plays" | "duration" | "addedDays" | "notPlayedDays";
            /** @enum {string} */
            op: "is" | "contains" | "gte" | "lte" | "eq" | "empty" | "any";
            value?: string | number | boolean;
        };
        SmartRules: {
            /** @default 100 */
            limit: number;
            /**
             * @default all
             * @enum {string}
             */
            match: "all" | "any";
            rules: components["schemas"]["SmartRule"][];
            /**
             * @description recent | oldest | title | artist | plays | duration | random | field:<поле>
             * @default recent
             */
            sort: string;
        };
        Stats: {
            bytes?: number;
            diskFreeMb?: number | null;
            duration?: number;
            genres?: {
                count?: number;
                genre?: string;
            }[];
            liked?: number;
            migrations?: {
                applied?: string[];
                pending?: number;
            };
            playlists?: number;
            plays?: number;
            tracks?: number;
            version?: string;
        };
        Track: {
            album?: string | null;
            artist: string;
            /** @description Есть ли обложка (файл отдаёт /cover) */
            cover: boolean;
            /** Format: date-time */
            createdAt: string;
            description?: string | null;
            duration: number;
            genre?: string | null;
            id: string;
            liked: boolean;
            mime: string;
            /** @description Нормализованные пики волны; в списке отсутствуют */
            peaks?: number[] | null;
            plays: number;
            size: number;
            title: string;
        };
        /** @description Состояние реплик трека по данным трекера */
        TrackSources: {
            devices?: number;
            /** @description sha256 содержимого (null, если файла не было) */
            hash?: string | null;
            kinds?: {
                [key: string]: number;
            };
            /** @description Файл лежит на узле, к которому обратились */
            local?: boolean;
            /** @description Копии, которые есть, но раздавать не умеют */
            replicas?: number;
            /** @description Устройства, которые реально отдадут файл по HTTP */
            servable?: number;
        };
    };
    responses: {
        /** @description Некорректные данные запроса */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description no_source — файл сейчас никто не раздаёт */
        NoSource: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Объект не найден */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Нет токена или подпись неверна */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
