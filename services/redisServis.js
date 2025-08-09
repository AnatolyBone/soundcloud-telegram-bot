// services/redisService.js
import { createClient } from 'redis';

class RedisService {
  constructor() {
    this.client = null;
  }

  async connect() {
    if (!this.client) {
      this.client = createClient({ url: process.env.REDIS_URL });
      await this.client.connect();
    }
    return this.client;
  }

  getClient() {
    if (!this.client) throw new Error('Redis client is not initialized');
    return this.client;
  }
}

export default new RedisService();
//test