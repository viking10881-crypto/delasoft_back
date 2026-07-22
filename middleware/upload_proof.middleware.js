const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");

// Los comprobantes pueden ser PDF o imagen — no forzamos WebP aquí
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder:    "delasoft/proofs",
    format:    file.mimetype === "application/pdf" ? "pdf" : "webp",
    transformation: file.mimetype !== "application/pdf"
      ? [{ quality: "auto:good" }]
      : undefined,
    public_id: `proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }),
});

module.exports = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Solo se permiten imágenes o PDF para el comprobante."));
  },
});