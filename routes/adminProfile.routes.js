const express = require('express');
const multer  = require('multer');

const { auth } = require('../middleware/auth.middleware');
const { adminScope }        = require('../middleware/adminScope');
const {
  getAdminProfile,
  upsertAdminProfile,
  uploadLogo,
  deleteLogo,
} = require('../controllers/adminProfile.controller');

const router = express.Router();

/* ── Multer en memoria → buffer va directo a Cloudinary ── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB máx
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Formato no permitido. Usa JPG, PNG, WEBP o SVG.'));
  },
});

/* ── Todas las rutas requieren auth + scope de admin ── */
router.use(auth, adminScope);

router.get('/',    getAdminProfile);
router.put('/',    upsertAdminProfile);

router.post('/logo',   upload.single('logo'), uploadLogo);
router.delete('/logo', deleteLogo);

module.exports = router;