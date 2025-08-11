// services/redisService.js

import { createClient } from 'redis';

class RedisService {
  constructor() {
    this.client = null;
  }

  async connect() {
    if (this.client) {
      return this.client; // Возвращаем существующее подключение, если оно есть
    }
    
    // <<< НАЧАЛО ИСПРАВЛЕНИЯ >>>
    // Render предоставляет полную строку подключения в REDIS_URL.
    // Убедимся, что она существует.
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl) {
      throw new Error('Переменная окружения REDIS_URL не найдена!');
    }
    
    console.log(`[Redis] Подключаюсь к: ${redisUrl.split('@')[1] || 'локальному хосту'}`); // Логируем хост для отладки

    this.client = createClient({ url: redisUrl });
    // <<< КОНЕЦ ИСПРАВЛЕНИЯ >>>

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