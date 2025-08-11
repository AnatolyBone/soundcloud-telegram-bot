// services/redisService.js

import { createClient } from 'redis';

class RedisService {
  constructor() {
    this.client = null;
  }

  async connect() {
    if (!this.client) {
      this.client = createClient({ url: process.env.REDIS_URL });
      this.client.on('error', (err) => console.error('🔴 Ошибка Redis:', err));
      await this.client.connect();
    }
    return this.client;
  }

  getClient() {
    if (!this.client) throw new Error('Redis client is not initialized');
    return this.client;
  }
}

// Экспортируем уже инициализированный экземпляр класса RedisService
export default new RedisService();