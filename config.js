// config.js
export const config = {
    // Лимиты Telegram
    TELEGRAM_FILE_LIMIT_MB: 49,
    MEDIA_GROUP_CHUNK_SIZE: 10,

    // Лимиты бота
    MAX_PLAYLIST_TRACKS_FREE: 15, // Немного увеличим для лояльности
    TRACK_TITLE_LIMIT: 100,
    MAX_CONCURRENT_DOWNLOADS: 8,

    // Rate Limiter: не более 30 запросов в минуту с одного пользователя
    RATE_LIMIT: {
        WINDOW_MS: 60 * 1000, // 1 минута
        MAX_REQUESTS: 30,
    },

    // Кэширование
    METADATA_CACHE_SECONDS: 300, // 5 минут
    FILE_ID_CACHE_SECONDS: 30 * 24 * 60 * 60, // 30 дней
    PLAYLIST_TRACKER_SECONDS: 3600, // 1 час
};