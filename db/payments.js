export async function checkPaymentExists(providerPaymentChargeId) {
  const res = await pool.query(
    'SELECT 1 FROM payments WHERE provider_payment_charge_id = $1 LIMIT 1',
    [providerPaymentChargeId]
  );
  return res.rowCount > 0;
}