const pool       = require('../config/db');
const cloudinary = require('../config/cloudinary');
const { Readable } = require('stream');
const { invalidateBrandingCache } = require('../services/branding.service');

/* ─────────────────────────────────────────────
   Helper: buffer → stream para Cloudinary
───────────────────────────────────────────── */
const bufferToStream = (buffer) => {
  const readable = new Readable();
  readable.push(buffer);
  readable.push(null);
  return readable;
};

/* ─────────────────────────────────────────────
   GET /api/admin-profile
───────────────────────────────────────────── */
const getAdminProfile = async (req, res) => {
  try {
    const { id } = req.user;

    // ❌ Elimina esto — resultado nunca usado
    // const { rows } = await pool.query(`SELECT ap.*, ...`, [id]);

    // ✅ Solo esta query importa
    const profileResult = await pool.query(
      'SELECT * FROM admin_profiles WHERE user_id = $1',
      [id]
    );

    res.json({
      success: true,
      data: profileResult.rows[0] ?? null,
    });
  } catch (error) {
    console.error('getAdminProfile error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el perfil' });
  }
};

/* ─────────────────────────────────────────────
   PUT /api/admin-profile
───────────────────────────────────────────── */
const upsertAdminProfile = async (req, res) => {
  try {
    const { id } = req.user;

    const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
    if (req.body.store_navbar_bg  && !HEX_RE.test(req.body.store_navbar_bg))
      return res.status(400).json({ success: false, message: 'store_navbar_bg debe ser un color hexadecimal válido (#RRGGBB)' });
    if (req.body.store_page_bg    && !HEX_RE.test(req.body.store_page_bg))
      return res.status(400).json({ success: false, message: 'store_page_bg debe ser un color hexadecimal válido (#RRGGBB)' });
    if (req.body.store_navbar_text && !['light', 'dark'].includes(req.body.store_navbar_text))
      return res.status(400).json({ success: false, message: 'store_navbar_text debe ser "light" o "dark"' });

    // Whitelist of updatable fields
    // For each field: transform(value) for fields present in req.body,
    //                 null for absent fields (COALESCE preserves existing value).
    // social_links is NOT NULL — absent → null in VALUES, but COALESCE(x, '{}') in INSERT.
    const ALLOWED = {
      business_name:                  v => v,
      tagline:                        v => v,
      description:                    v => v,
      tax_id:                         v => v,
      favicon_url:                    v => v,
      primary_color:                  v => v,
      secondary_color:                v => v,
      accent_color:                   v => v,
      business_email:                 v => v,
      business_phone:                 v => v,
      website:                        v => v,
      address:                        v => v,
      city:                           v => v,
      department:                     v => v,
      country:                        v => v,
      currency:                       v => v,
      timezone:                       v => v,
      social_links:                   v => v ?? {},
      default_fulfillment_mode:       v => v ?? 'stock',
      partial_shipment_allowed:       v => v !== undefined && v !== null ? Boolean(v) : false,
      auto_create_procurement_orders: v => v !== undefined && v !== null ? Boolean(v) : true,
      store_navbar_bg:                v => v,
      store_navbar_text:              v => v,
      store_page_bg:                  v => v,
      store_font:                     v => v,
    };

    const fieldNames = Object.keys(ALLOWED);

    const hasChanges = fieldNames.some(k => k in req.body);
    if (!hasChanges) {
      const { rows: cur } = await pool.query('SELECT * FROM admin_profiles WHERE user_id = $1', [id]);
      return res.json({ success: true, data: cur[0] ?? null, message: 'Sin cambios' });
    }

    // Build values: use transform for sent fields, null for absent ones.
    // social_links gets '{}' in the INSERT expression via COALESCE so NOT NULL is satisfied.
    const insertVals = [id]; // $1 = user_id
    for (const [col, transform] of Object.entries(ALLOWED)) {
      insertVals.push(col in req.body ? transform(req.body[col]) : null);
    }

    // Placeholders: $2..$N for the field columns
    const colPlaceholders = fieldNames.map((_, i) => {
      const p = `$${i + 2}`;
      // social_links is NOT NULL — wrap in COALESCE so new rows satisfy the constraint
      return fieldNames[i] === 'social_links' ? `COALESCE(${p}::jsonb, '{}')` : p;
    });

    // DO UPDATE: COALESCE(EXCLUDED.col, existing) so absent fields don't overwrite.
    // social_links is special: COALESCE($i, '{}') in VALUES makes EXCLUDED non-null even
    // when the param is null (absent). Reference original binding $i in DO UPDATE to
    // distinguish "not sent (null)" from "sent as '{}'" so we don't clobber existing value.
    const updateClauses = fieldNames.map((col, i) => {
      const paramIdx = i + 2; // $1 = user_id; fields start at $2
      if (col === 'social_links') {
        return `${col} = CASE WHEN $${paramIdx} IS NOT NULL THEN EXCLUDED.${col} ELSE COALESCE(admin_profiles.${col}, '{}') END`;
      }
      return `${col} = COALESCE(EXCLUDED.${col}, admin_profiles.${col})`;
    });

    const { rows } = await pool.query(
      `INSERT INTO admin_profiles (user_id, ${fieldNames.join(', ')})
       VALUES ($1, ${colPlaceholders.join(', ')})
       ON CONFLICT (user_id) DO UPDATE SET
         ${updateClauses.join(',\n         ')},
         updated_at = NOW()
       RETURNING *`,
      insertVals
    );

    invalidateBrandingCache(id);
    res.json({ success: true, data: rows[0], message: 'Perfil actualizado correctamente' });
  } catch (error) {
    console.error('upsertAdminProfile error:', error);
    res.status(500).json({ success: false, message: 'Error al guardar el perfil' });
  }
};

/* ─────────────────────────────────────────────
   POST /api/admin-profile/logo
───────────────────────────────────────────── */
const uploadLogo = async (req, res) => {
  try {
    const { id } = req.user;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No se recibió ningún archivo' });
    }

    // Obtener el public_id anterior para borrarlo de Cloudinary
    const existing = await pool.query(
      'SELECT logo_public_id FROM admin_profiles WHERE user_id = $1',
      [id]
    );

    if (existing.rows[0]?.logo_public_id) {
      await cloudinary.uploader.destroy(existing.rows[0].logo_public_id).catch(() => {});
    }

    // Subir nuevo logo
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder:    `admin_logos/${id}`,
          public_id: `logo_${id}_${Date.now()}`,
          overwrite: true,
          resource_type: 'image',
          transformation: [
            { width: 400, height: 400, crop: 'limit' }, // Max 400px, sin distorsionar
            { quality: 'auto:best' },
            { format: 'webp' },
          ],
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );

      bufferToStream(req.file.buffer).pipe(uploadStream);
    });

    // Upsert con el nuevo logo
    const { rows } = await pool.query(
      `INSERT INTO admin_profiles (user_id, logo_url, logo_public_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id)
       DO UPDATE SET
         logo_url       = EXCLUDED.logo_url,
         logo_public_id = EXCLUDED.logo_public_id,
         updated_at     = now()
       RETURNING logo_url, logo_public_id`,
      [id, uploadResult.secure_url, uploadResult.public_id]
    );

    res.json({
      success: true,
      data: rows[0],
      message: 'Logo actualizado correctamente',
    });
  } catch (error) {
    console.error('uploadLogo error:', error);
    res.status(500).json({ success: false, message: 'Error al subir el logo' });
  }
};

/* ─────────────────────────────────────────────
   DELETE /api/admin-profile/logo
───────────────────────────────────────────── */
const deleteLogo = async (req, res) => {
  try {
    const { id } = req.user;

    const { rows } = await pool.query(
      'SELECT logo_public_id FROM admin_profiles WHERE user_id = $1',
      [id]
    );

    if (rows[0]?.logo_public_id) {
      await cloudinary.uploader.destroy(rows[0].logo_public_id).catch(() => {});
    }

    await pool.query(
      `UPDATE admin_profiles
       SET logo_url = NULL, logo_public_id = NULL, updated_at = now()
       WHERE user_id = $1`,
      [id]
    );

    res.json({ success: true, message: 'Logo eliminado' });
  } catch (error) {
    console.error('deleteLogo error:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar el logo' });
  }
};

module.exports = { getAdminProfile, upsertAdminProfile, uploadLogo, deleteLogo };