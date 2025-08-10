// redisClientSingleton.js
import RedisService from './services/redisService.js';

class RedisClientSingleton {
  constructor() {
    if (RedisClientSingleton.instance) {
      return RedisClientSingleton.instance;
    }
    this.client = null;
    RedisClientSingleton.instance = this;
  }

  async getClient() {
    if (!this.client) {
      // Connect using the shared RedisService instance imported above.
      this.client = await RedisService.connect();
      console.log('вњ… Redis РїРѕРґРєР»СЋС‡С‘РЅ');
    }
    return this.client;
  }
}

export const redisClientSingleton = new RedisClientSingleton();