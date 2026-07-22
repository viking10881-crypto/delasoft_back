// routes/users.routes.js
// Cada admin gestiona únicamente sus propios usuarios.
// El superadmin puede operar sobre todos (bypass en middleware).
const express      = require("express");
const router       = express.Router();
const usersCtrl    = require("../controllers/users.controller");
const creditProfile = require("../controllers/creditProfile.controller");
const { auth, requireAdmin } = require("../middleware/auth.middleware");

// Todas las rutas requieren autenticación como mínimo admin
router.use(auth, requireAdmin);

// ─── CRUD ────────────────────────────────────────────────────
// GET    /api/users          → Lista usuarios del admin (o todos si superadmin)
router.get("/", usersCtrl.getUsers);

// POST   /api/users          → Crear usuario vinculado al admin autenticado
router.post("/", usersCtrl.createUser);

// PUT    /api/users/:id      → Actualizar datos del usuario (solo propios)
router.put("/:id", usersCtrl.updateUser);

// PATCH  /api/users/:id/toggle → Activar / desactivar (solo propios)
router.patch("/:id/toggle", usersCtrl.toggleUserStatus);

// DELETE /api/users/:id      → Eliminar usuario (solo propios)
router.delete("/:id", usersCtrl.deleteUser);

// GET /api/users/:id/credit-profile → Historial crediticio del cliente
router.get("/:id/credit-profile", creditProfile.getCreditProfile);

module.exports = router;