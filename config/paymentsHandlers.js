import { checkPaymentExists, savePaymentAndActivateSubscription } from '../db/payments.js';
import { PLANS, INVOICE_PAYLOAD_PREFIX } from '../config/subscriptions.js';

export function registerPaymentHandlers(bot) {
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

  bot.on('successful_payment', async (ctx) => {
    try {
      const payment = ctx.message.successful_payment;
      const payload = payment.invoice_payload;
      const parts = payload.split('#');
      if (parts.length !== 3 || parts[0] !== INVOICE_PAYLOAD_PREFIX) {
        return ctx.reply('Ошибка данных платежа. Свяжитесь с поддержкой.');
      }

      const [_, planId, userIdFromPayload] = parts;
      const chatId = ctx.chat.id;

      if (String(chatId) !== userIdFromPayload) {
        console.warn(`Потенциальная подмена chatId!`);
        return ctx.reply('Ошибка безопасности платежа.');
      }

      const plan = PLANS[planId];
      if (!plan) {
        return ctx.reply('Выбран неверный тариф.');
      }

      if (payment.total_amount !== plan.price) {
        return ctx.reply('Неверная сумма платежа.');
      }

      const exists = await checkPaymentExists(payment.provider_payment_charge_id);
      if (exists) {
        return ctx.reply('Этот платёж уже обработан. Спасибо!');
      }

      await savePaymentAndActivateSubscription(chatId, payment.provider_payment_charge_id, plan);
      await ctx.reply(`✅ Оплата прошла успешно! Подписка активирована на ${plan.days} дней.`);
    } catch (e) {
      console.error('Ошибка успешного платежа:', e);
      await ctx.reply('Произошла ошибка при обработке платежа.');
    }
  });
}