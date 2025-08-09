// botLaunchStrategies.js
class BotLaunchStrategy {
  launch(bot) {}
}

class WebhookLaunchStrategy extends BotLaunchStrategy {
  launch(bot) {
    app.use(await bot.createWebhook({
      domain: WEBHOOK_URL,
      path: WEBHOOK_PATH,
    }));
    app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}.`));
  }
}

class LongPollingLaunchStrategy extends BotLaunchStrategy {
  launch(bot) {
    bot.launch();
    console.log('✅ Бот запущен в режиме long-polling.');
  }
}

export { WebhookLaunchStrategy, LongPollingLaunchStrategy };