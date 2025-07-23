bot.on('pre_checkout_query', async (ctx) => {
  try {
    const payload = ctx.preCheckoutQuery.invoicePayload;
    const valid = new RegExp(`^${INVOICE_PAYLOAD_PREFIX}#(\\w+)#(\\d+)$`).test(payload);
    if (valid) {
      await ctx.answerPreCheckoutQuery(true);
    } else {
      await ctx.answerPreCheckoutQuery(false, 'Некорректный запрос');
    }
  } catch (e) {
    console.error('Ошибка pre_checkout_query:', e);
  }
});