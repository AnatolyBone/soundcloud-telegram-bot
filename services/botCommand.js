// services/botCommand.js
class BotCommand {
  constructor(name) {
    this.name = name;
  }

  execute(ctx) {
    throw new Error('execute method must be implemented');
  }
}

class StartCommand extends BotCommand {
  constructor() {
    super('start');
  }

  async execute(ctx) {
    const user = await getUser(ctx.from.id);
    await ctx.reply('Hello, ' + user.first_name);
  }
}

export { BotCommand, StartCommand };