export async function safeOperation(fn, ctx, fallbackMessage = 'Произошла ошибка. Попробуйте позже.') {
  try {
    await fn();
  } catch (error) {
    console.error('❌ Ошибка в safeOperation:', error);
    if (ctx?.reply) {
      await ctx.reply(fallbackMessage);
    }
  }
}