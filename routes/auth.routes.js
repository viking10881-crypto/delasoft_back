// routes/auth.routes.js
// ARQUITECTURA:
//   - superadmin crea admins → via /api/superadmin/admins
//   - admin crea sus usuarios → via /api/users
//   - El registro público (/register) queda desactivado en esta arquitectura
//     porque los usuarios los crea directamente el admin desde el panel.
//   - Si en el futuro quieres auto-registro en el sitio web del admin,
//     usa la ruta /public-api/v1/register con API Key.

const express = require("express");
const router  = express.Router();

const authController           = require("../controllers/auth.controller");
const { auth, checkRateLimit } = require("../middleware/auth.middleware");
const { uploadAvatar }         = require("../middleware/upload.middleware");

// ============================================
// 🔓 RUTAS PÚBLICAS
// ============================================

// Login — panel admin y app cliente
router.post(
  "/login",
  checkRateLimit("email", 20, 15 * 60 * 1000),
  authController.login
);

// Verificación de email (para el flujo de auto-registro si lo habilitas)
router.post("/verify",     authController.verifyEmail);
router.post("/google",     authController.googleLogin);
router.post(
  "/resend-code",
  checkRateLimit("email", 3, 60 * 60 * 1000),
  authController.resendVerificationCode
);

// Renovación de token
router.post("/refresh",    authController.refreshToken);

// ============================================
// SETUP INICIAL — solo disponible fuera de producción
// ============================================
if (process.env.NODE_ENV !== "production") {
  router.post("/setup", authController.setupAdmin);
}

// ============================================
// 🔐 RUTAS PROTEGIDAS
// ============================================

const uploadProfileAvatarMiddleware = (req, res, next) => {
  uploadAvatar.single("avatar")(req, res, (err) => {
    if (err) {
      let message = "Error al procesar la imagen";
      let code = "UPLOAD_ERROR";

      if (err.code === "LIMIT_FILE_SIZE") {
        message = "La imagen es demasiado grande. Usa una menor a 2 MB.";
        code = "FILE_TOO_LARGE";
      } else if (err.code === "LIMIT_UNEXPECTED_FILE") {
        message = "Campo de archivo inválido";
        code = "INVALID_FIELD";
      } else if (err.message) {
        message = err.message;
        code = "INVALID_FILE";
      }

      return res.status(400).json({ success: false, message, code });
    }

    next();
  });
};

router.post("/logout",     auth, authController.logout);
router.get ("/profile",    auth, authController.getProfile);
router.put ("/profile",    auth, authController.updateProfile);
router.post("/profile/avatar", auth, uploadProfileAvatarMiddleware, authController.uploadProfileAvatar);

// Cambio de contraseña propio
router.post("/change-password", auth, authController.changePassword);

// Verificar token activo (útil para el frontend al iniciar)
router.get("/verify-token", auth, (req, res) => {
  res.json({
    success: true,
    message: "Token válido",
    data: { user: req.user },
  });
});

module.exports = router;