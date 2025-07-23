import { pool } from './db'; // если pool не импортирован

export async function checkPaymentExists(providerPaymentChargeId) {
  const res = await pool.query(
    'SELECT 1 FROM payments WHERE provider_payment_charge_id = $1 LIMIT 1',
    [providerPaymentChargeId]
  );
  return res.rowCount > 0;
}

export async function savePaymentAndActivateSubscription(chatId, providerPaymentChargeId, plan) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO payments (user_id, amount, provider_payment_charge_id, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [chatId, plan.price / 100, providerPaymentChargeId]
    );

    const until = new Date(Date.now() + plan.days * 86400000).toISOString();
    await client.query(
      `UPDATE users SET premium_limit = $1, premium_until = $2 WHERE id = $3`,
      [plan.limit, until, chatId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}