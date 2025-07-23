import { bot } from './index.js';
import { PLANS, INVOICE_PAYLOAD_PREFIX, START_PARAMETER } from './config/subscriptions.js';
import { getUserPhone } from './db/users.js';

export async function sendInvoice(chatId, planId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error('Invalid plan');

  const phoneNumber = await getUserPhone(chatId);

  const prices = [{ label: `${planId} subscription`, amount: plan.price }];

  const providerData = {
    receipt: {
      items: [{
        description: `${planId} subscription`,
        quantity: 1,
        amount: { value: (plan.price / 100).toFixed(2), currency: 'RUB' },
        vat_code: 1,
      }]
    }
  };

  await bot.telegram.sendInvoice(chatId,
    'Premium Subscription',
    'Подписка на премиум бота',
    `${INVOICE_PAYLOAD_PREFIX}#${planId}#${chatId}`,
    process.env.PROVIDER_TOKEN,
    START_PARAMETER,
    'RUB',
    prices,
    {
      provider_data: JSON.stringify(providerData),
      need_phone_number: !phoneNumber,
      send_phone_number_to_provider: !phoneNumber,
    }
  );
}