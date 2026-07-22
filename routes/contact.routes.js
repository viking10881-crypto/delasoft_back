// routes/contact.routes.js
const express = require("express");
const { auth, isAdmin } = require("../middleware/auth.middleware"); // ajusta si tu middleware de admin tiene otro nombre
const {
  submit,
  list,
  markRead,
  reply,
  remove,
} = require("../controllers/contact.controller");

const router = express.Router();

// Público — cualquier visitante puede enviar un mensaje
router.post("/",                 submit);

// Admin — requieren autenticación
router.get("/",                  auth, list);
router.patch("/:id/read",        auth, markRead);
router.post("/:id/reply",        auth, reply);
router.delete("/:id",            auth, remove);

module.exports = router;

// ── Registrar en app.js ───────────────────────────────────────────────────────
// app.use("/api/contact", require("./routes/contact.routes"));