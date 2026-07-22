// routes/products.routes.js
const express = require("express");
const { auth, requireRole } = require("../middleware/auth.middleware");
const { adminScope }        = require("../middleware/adminScope");
const { uploadProduct }     = require("../middleware/upload.middleware");
const ctrl = require("../controllers/products.controller");
const db     = require("../config/db");
const invSvc = require("../services/inventory.service");

const router = express.Router();

// ── Middleware global para este router ────────────────────────
router.use(auth);
router.use(adminScope);

// ── Rutas ─────────────────────────────────────────────────────
router.get("/",    ctrl.getAll);
router.get("/:id", ctrl.getById);

// ── Ledger de stock ───────────────────────────────────────────
router.get("/:id/ledger", requireRole(["admin", "gerente"]), ctrl.getLedger);

router.post(
  "/",
  requireRole(["admin", "gerente"]),
  uploadProduct.array("images", 6),
  ctrl.create
);

router.put(
  "/:id",
  requireRole(["admin", "gerente"]),
  uploadProduct.array("images", 6),
  ctrl.update
);

router.delete(
  "/:id",
  requireRole(["admin", "gerente"]),
  ctrl.remove
);

router.patch(
  "/:id/stock",
  requireRole(["admin", "gerente"]),
  async (req, res) => {
    try {
      const { stock } = req.body;
      if (stock === undefined || stock < 0)
        return res.status(400).json({ success: false, message: "Stock debe ser un número positivo" });

      const { isSuperAdmin, adminId } = req;
      const ownerClause = isSuperAdmin ? "" : "AND owner_admin_id = $2";
      const params      = isSuperAdmin ? [req.params.id] : [req.params.id, adminId];

      const check = await db.query(
        `SELECT stock, owner_admin_id FROM products WHERE id = $1 ${ownerClause}`, params
      );
      if (!check.rowCount)
        return res.status(403).json({ success: false, message: "No autorizado o producto no encontrado" });

      const current = check.rows[0];
      const delta   = stock - current.stock;

      if (delta !== 0) {
        await invSvc.manualAdjustment(
          { productId: Number(req.params.id), variantId: null, delta,
            reason: 'Ajuste manual de stock desde panel admin' },
          { ownerAdminId: current.owner_admin_id, userId: req.user.id }
        );
      }
      res.json({ success: true, message: "Stock actualizado correctamente" });
    } catch (err) {
      console.error("UPDATE STOCK ERROR:", err);
      res.status(500).json({ success: false, message: "Error al actualizar stock" });
    }
  }
);

router.patch(
  "/:id/main-image",
  requireRole(["admin", "gerente"]),
  async (req, res) => {
    const { image_id } = req.body;
    if (!image_id)
      return res.status(400).json({ success: false, message: "image_id es requerido" });

    const { isSuperAdmin, adminId } = req;
    const ownerClause  = isSuperAdmin ? "" : "AND owner_admin_id = $2";
    const checkParams  = isSuperAdmin ? [req.params.id] : [req.params.id, adminId];

    const check = await db.query(
      `SELECT id FROM products WHERE id = $1 ${ownerClause}`, checkParams
    );
    if (!check.rowCount)
      return res.status(403).json({ success: false, message: "No autorizado o producto no encontrado" });

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE product_images SET is_main = false WHERE product_id = $1",
        [req.params.id]
      );
      const result = await client.query(
        "UPDATE product_images SET is_main = true WHERE id = $1 AND product_id = $2",
        [image_id, req.params.id]
      );
      if (!result.rowCount) throw new Error("Imagen no encontrada o no pertenece al producto");
      await client.query("COMMIT");
      res.json({ success: true, message: "Imagen principal actualizada" });
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ success: false, message: err.message || "Error al actualizar imagen principal" });
    } finally {
      client.release();
    }
  }
);

module.exports = router;