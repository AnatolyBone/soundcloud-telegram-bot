// services/redisService.js

import { createClient } from 'redis';

class RedisService {
  constructor() {
    this.client = null;
  }

  async connect() {
    if (this.client) {
      return this.client;
    }
    
    // <<< НАЧАЛО ФИНАЛЬНОГО ИСПРАВЛЕНИЯ >>>
    
    let redisUrl;

    // Сначала пытаемся использовать полную строку подключения, если она есть
    if (process.env.REDIS_URL && process.env.REDIS_URL.startsWith('redis://')) {
        redisUrl = process.env.REDIS_URL;
    } else {
        // Если полной строки нет, собираем ее из отдельных частей,
        // которые Render точно предоставляет.
        const host = process.env.REDIS_HOST;
        const port = process.env.REDIS_PORT;
        const password = process.env.REDIS_PASSWORD;
        const user = process.env.REDIS_USER || 'default'; // Redis 6+ требует пользователя

        if (!host || !port || !password) {
            throw new Error('Не найдены все необходимые переменные окружения для Redis (REDIS_HOST, REDIS_PORT, REDIS_PASSWORD)');
        }

        redisUrl = `redis://${user}:${password}@${host}:${port}`;
    }
    
    console.log(`[Redis] Подключаюсь к: ${redisUrl.split('@')[1] || 'неизвестному хосту'}`);

    this.client = createClient({ url: redisUrl });
    
    // <<< КОНЕЦ ФИНАЛЬНОГО ИСПРАВЛЕНИЯ >>>

    this.client.on('error', (err) => console.error('🔴 Ошибка Redis:', err));
    await this.client.connect();
    
    return this.client;
  }

  getClient() {
    if (!this.client) {
      throw new Error('Redis клиент не инициализирован. Вызовите connect() сначала.');
    }
    return this.client;
  }
}

export default new RedisService();