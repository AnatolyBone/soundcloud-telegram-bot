import { Telegraf } from 'telegraf';
import { setPremium } from './subscription.js'; // твоя логика активации подписки
import { savePaymentRecord } from './payments.js'; // сохраняем платежи в БД
import { getUserPhone } from './users.js'; // получаем телефон пользователя из БД

const BOT_TOKEN = process.env.BOT_TOKEN;
const PROVIDER_TOKEN = process.env.PROVIDER_TOKEN; // токен Юкассы для Telegram

const bot = new Telegraf(BOT_TOKEN);

// Обработка pre-checkout запроса (подтверждение платежа)
bot.on('pre_checkout_query', async (ctx) => {
  try {
    const payload = ctx.preCheckoutQuery.invoicePayload;
    if (payload && payload.startsWith('avandy-news')) {
      await ctx.answerPreCheckoutQuery(true);
    } else {
      await ctx.answerPreCheckoutQuery(false, 'Попробуйте снова!');
    }
  } catch (error) {
    console.error('Ошибка pre_checkout_query:', error);
  }
});

// Обработка успешного платежа
bot.on('successful_payment', async (ctx) => {
  try {
    const payment = ctx.message.successful_payment;
    const payload = payment.invoice_payload;
    const chatId = ctx.chat.id;

    if (!payload.startsWith('avandy-news')) {
      return ctx.reply('Ошибка оплаты, попробуйте снова!');
    }

    const totalAmount = payment.total_amount; // в копейках
    const sum = totalAmount / 100; // в рублях
    const currency = payment.currency;
    const providerPaymentChargeId = payment.provider_payment_charge_id;

    // Сохраняем платеж в БД
    await savePaymentRecord(chatId, sum, currency, providerPaymentChargeId);

    // Активируем премиум подписку (примерно 1 месяц и лимит)
    await setPremium(chatId, 50, 30); // 50 лимит, 30 дней подписки (поменяй под себя)

    await ctx.reply(`Оплата прошла успешно! Подписка активирована на 30 дней.`);
  } catch (error) {
    console.error('Ошибка успешного платежа:', error);
    await ctx.reply('Произошла ошибка при обработке платежа. Свяжитесь с поддержкой.');
  }
});

// Функция отправки счета (инвойса)
async function sendInvoice(chatId, label, amountRub) {
  try {
    const phoneNumber = await getUserPhone(chatId); // Получаем телефон из базы

    const prices = [
      { label, amount: amountRub * 100 } // в копейках
    ];

    const providerData = {
      receipt: {
        items: [
          {
            description: label,
            quantity: 1,
            amount: {
              value: amountRub.toFixed(2),
              currency: 'RUB'
            },
            vat_code: 1
          }
        ]
      }
    };

    await bot.telegram.sendInvoice(chatId, 
      label,                // title
      'Подписка на премиум бота', // description
      `avandy-news#${chatId}`, // payload
      PROVIDER_TOKEN,
      'payment-invoice',     // start_parameter
      'RUB',
      prices,
      {
        provider_data: JSON.stringify(providerData),
        need_phone_number: !phoneNumber,
        send_phone_number_to_provider: !phoneNumber,
      }
    );
  } catch (error) {
    console.error('Ошибка при отправке инвойса:', error);
  }
}

export { bot, sendInvoice };