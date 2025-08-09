// serviceFactory.js
class ServiceFactory {
  static createBotService(bot) {
    return new BotService(bot);
  }

  static createRedisService() {
    return new RedisService();
  }

  // Можно добавить другие сервисы
}

export default ServiceFactory;