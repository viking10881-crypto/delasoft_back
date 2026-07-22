const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");

function createUpload(folder = "general", maxSizeMB = 5) {
  const storage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => ({
      folder:         `delasoft/${folder}`,
      format:         "webp",
      transformation: [{ quality: "auto:good" }],
      public_id:      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }),
  });

  return multer({
    storage,
    limits: { fileSize: maxSizeMB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
      if (allowed.includes(file.mimetype)) cb(null, true);
      else cb(new Error(`Formato no soportado: ${file.mimetype}. Usa JPG, PNG o WebP.`));
    },
  });
}

const uploadProduct = createUpload("products");
const uploadBanner  = createUpload("banners", 10);
const uploadBundle  = createUpload("bundles");
const uploadAvatar  = createUpload("avatars", 2);
const upload        = createUpload("misc");

module.exports = { createUpload, upload, uploadProduct, uploadBanner, uploadBundle, uploadAvatar };