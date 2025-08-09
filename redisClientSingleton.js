// redisClientSingleton.js
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
      this.client = await redisService.connect();
      console.log('✅ Redis подключён');
    }
    return this.client;
  }
}

export const redisClientSingleton = new RedisClientSingleton();