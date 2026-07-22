const db = require("../config/db");

exports.registerPayment = async (req, res) => {
  const { provider_id, amount, payment_method } = req.body;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 1. Registrar el pago en la tabla de abonos
    await client.query(
      "INSERT INTO provider_payments (provider_id, amount, payment_method) VALUES ($1, $2, $3)",
      [provider_id, amount, payment_method]
    );

    // 2. RESTAR el monto del balance del proveedor
    await client.query(
      "UPDATE providers SET balance = balance - $1 WHERE id = $2",
      [amount, provider_id]
    );

    await client.query("COMMIT");
    res.json({ message: "Pago registrado y deuda actualizada" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};