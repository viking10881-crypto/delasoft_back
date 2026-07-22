// routes/roles.routes.js
const express             = require("express");
const router              = express.Router();
const rolesCtrl           = require("../controllers/roles.controller");
const { auth, requireAdmin, requireSuperAdmin } = require("../middleware/auth.middleware");

// GET  /api/roles  — Admins y superadmin pueden listar (para poblar selectores)
router.get("/", auth, requireAdmin, rolesCtrl.getRoles);

// POST /api/roles  — Solo superadmin crea roles nuevos
router.post("/", auth, requireSuperAdmin, rolesCtrl.createRole);

// DELETE /api/roles/:id — Solo superadmin elimina (con protección de roles del sistema)
router.delete("/:id", auth, requireSuperAdmin, rolesCtrl.deleteRole);

module.exports = router;