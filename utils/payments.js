import { Telegraf } from 'telegraf';

// Нужно передавать сюда бота и функцию обновления подписки
export function setupPayments(bot, setPremium, providerToken) {

  // Отправка счета пользователю (invoice)
  bot.command('buy', async (ctx) => {
    const prices = [
      { label: 'Подписка на 1 месяц', amount: 25000 } // 250.00 ₽ в копейках
    ];

    try {
      await ctx.replyWithInvoice({
        title: 'Премиум подписка',
        description: '1 месяц премиум-доступа к функционалу бота',
        payload: `premium#${ctx.from.id}`,
        provider_token: providerToken,
        currency: 'RUB',
        prices,
        start_parameter: 'buy_subscription',
        need_phone_number: true,
        send_phone_number_to_provider: true,
        provider_data: JSON.stringify({
          receipt: {
            items: [
              {
                description: 'Премиум подписка',
                quantity: 1,
                amount: { value: '250.00', currency: 'RUB' },
                vat_code: 1
              }
            ]
          }
        })
      });
    } catch (error) {
      console.error('Ошибка отправки счета:', error);
      ctx.reply('Произошла ошибка при формировании счета, попробуйте позже.');
    }
  });

  // Обработка pre_checkout_query
  bot.on('pre_checkout_query', (ctx) => {
    const payload = ctx.update.pre_checkout_query.invoice_payload;
    if (payload && payload.startsWith('premium#')) {
      return ctx.answerPreCheckoutQuery(true);
    }
    return ctx.answerPreCheckoutQuery(false, 'Ошибка оплаты, попробуйте снова.');
  });

  // Обработка успешного платежа
  bot.on('successful_payment', async (ctx) => {
    try {
      const payment = ctx.message.successful_payment;
      const payload = payment.invoice_payload;
      const userId = ctx.from.id;
      const totalAmount = payment.total_amount / 100; // в рублях

      if (payload.startsWith('premium#')) {
        // Обновляем подписку: лимит 25 треков на 30 дней
        await setPremium(userId, 25, 30);

        await ctx.reply(`✅ Оплата прошла успешно!
Вы получили премиум-доступ на 30 дней.
Сумма: ${totalAmount} ₽`);
      } else {
        await ctx.reply('Оплата не распознана, попробуйте снова.');
      }
    } catch (error) {
      console.error('Ошибка при обработке успешного платежа:', error);
      await ctx.reply('Произошла ошибка при подтверждении оплаты.');
    }
  });
}