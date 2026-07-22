// controllers/reviews.controller.js
const db = require("../config/db");
const { emitDataUpdate } = require("../config/socket");

// ─── Helper: refrescar la vista materializada (fire-and-forget) ──────────────
const refreshStats = () =>
  db
    .query("REFRESH MATERIALIZED VIEW CONCURRENTLY product_review_stats")
    .catch((e) => console.error("[Reviews] refresh stats:", e.message));

// ─────────────────────────────────────────────────────────────────────────────
// createReview — POST /api/reviews
// ─────────────────────────────────────────────────────────────────────────────
exports.createReview = async (req, res) => {
  const { product_id, rating, title, body, images = [] } = req.body;

  // VALIDATION 5 — Required fields
  if (!product_id || rating === undefined || rating === null || rating === "")
    return res.status(400).json({ success: false, message: "product_id y rating son requeridos" });

  // VALIDATION 4 — Rating range
  const ratingNum = parseInt(rating, 10);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5)
    return res.status(400).json({ success: false, message: "La calificación debe ser un número entre 1 y 5" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Verificar que el producto existe y obtener el tenant
    const { rows: prodRows } = await client.query(
      "SELECT id, owner_admin_id FROM products WHERE id = $1 AND is_active = true",
      [product_id]
    );
    if (!prodRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Producto no encontrado" });
    }
    const ownerAdminId = prodRows[0].owner_admin_id;

    // VALIDATION 3 — One review per user per product (explicit check, not just constraint)
    const { rows: existingRows } = await client.query(
      "SELECT id FROM reviews WHERE user_id = $1 AND product_id = $2",
      [req.user.id, product_id]
    );
    if (existingRows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "Ya tienes una reseña para este producto" });
    }

    // VALIDATION 2 — Verified purchase (enforced: must have paid for the product)
    const { rows: purchaseRows } = await client.query(
      `SELECT si.id
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE s.customer_id    = $1
         AND si.product_id    = $2
         AND s.payment_status = 'paid'
       LIMIT 1`,
      [req.user.id, product_id]
    );
    if (!purchaseRows.length) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        message: "Solo puedes reseñar productos que hayas comprado y pagado",
      });
    }
    const orderItemId = purchaseRows[0].id;

    // Insertar reseña — is_verified_purchase siempre true aquí (garantizado por V2)
    const { rows } = await client.query(
      `INSERT INTO reviews
         (product_id, user_id, rating, title, body,
          status, is_verified_purchase, order_item_id)
       VALUES ($1, $2, $3, $4, $5, 'approved', true, $6)
       RETURNING *`,
      [
        product_id, req.user.id,
        ratingNum, title?.trim() || null, body?.trim() || null,
        orderItemId,
      ]
    );
    const review = rows[0];

    // Insertar imágenes (URLs ya subidas a Cloudinary)
    const insertedImages = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img?.url) continue;
      const { rows: imgRows } = await client.query(
        `INSERT INTO review_images (review_id, url, public_id, position)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [review.id, img.url, img.public_id || null, i]
      );
      insertedImages.push(imgRows[0]);
    }

    await client.query("COMMIT");

    refreshStats();
    emitDataUpdate("reviews", "created", { id: review.id, product_id }, ownerAdminId);

    return res.status(201).json({
      success: true,
      message: "Reseña publicada",
      data: { ...review, images: insertedImages },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Reviews] createReview:", err);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// getProductReviews — GET /api/products/:productId/reviews  (público)
// ─────────────────────────────────────────────────────────────────────────────
exports.getProductReviews = async (req, res) => {
  const { productId } = req.params;
  const {
    page     = 1,
    limit    = 10,
    sort     = "recent",
    rating   = null,
    verified = null,
  } = req.query;

  const safeLimit  = Math.min(parseInt(limit) || 10, 50);
  const safeOffset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

  const sortMap = {
    recent:  "r.created_at DESC",
    helpful: "r.helpful_count DESC, r.created_at DESC",
    highest: "r.rating DESC, r.created_at DESC",
    lowest:  "r.rating ASC, r.created_at DESC",
  };
  const orderBy = sortMap[sort] || sortMap.recent;

  const params  = [productId];
  let filters = "";

  if (rating) {
    params.push(parseInt(rating));
    filters += ` AND r.rating = $${params.length}`;
  }
  if (verified === "true") {
    filters += " AND r.is_verified_purchase = true";
  }

  try {
    const [reviewsRes, countRes, statsRes] = await Promise.all([
      db.query(
        `SELECT
           r.id, r.rating, r.title, r.body,
           r.is_verified_purchase, r.helpful_count,
           r.created_at, r.updated_at,
           u.name AS user_name,
           COALESCE(
             (SELECT json_agg(
               json_build_object('id', ri.id, 'url', ri.url)
               ORDER BY ri.position
             ) FROM review_images ri WHERE ri.review_id = r.id),
             '[]'
           ) AS images
         FROM reviews r
         JOIN users u ON u.id = r.user_id
         WHERE r.product_id = $1
           AND r.status = 'approved'
           ${filters}
         ORDER BY ${orderBy}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, safeLimit, safeOffset]
      ),
      db.query(
        `SELECT COUNT(*) FROM reviews r
         WHERE r.product_id = $1 AND r.status = 'approved' ${filters}`,
        params
      ),
      db.query(
        `SELECT
           COUNT(*)                                    AS review_count,
           AVG(rating)                                 AS avg_rating,
           COUNT(*) FILTER (WHERE rating = 5)          AS stars_5,
           COUNT(*) FILTER (WHERE rating = 4)          AS stars_4,
           COUNT(*) FILTER (WHERE rating = 3)          AS stars_3,
           COUNT(*) FILTER (WHERE rating = 2)          AS stars_2,
           COUNT(*) FILTER (WHERE rating = 1)          AS stars_1
         FROM reviews
         WHERE product_id = $1 AND status = 'approved'`,
        [productId]
      ),
    ]);

    const total = parseInt(countRes.rows[0].count);
    const stats = statsRes.rows[0] ?? {
      review_count: 0, avg_rating: null,
      stars_5: 0, stars_4: 0, stars_3: 0, stars_2: 0, stars_1: 0,
    };

    // Info personalizada si hay usuario autenticado (req.user puede ser undefined)
    let has_reviewed = false;
    const userVotes  = {};

    if (req.user?.id) {
      const reviewIds = reviewsRes.rows.map((r) => r.id);
      const [myReview, votes] = await Promise.all([
        db.query(
          "SELECT id FROM reviews WHERE product_id = $1 AND user_id = $2",
          [productId, req.user.id]
        ),
        reviewIds.length
          ? db.query(
              `SELECT review_id, helpful FROM review_votes
               WHERE user_id = $1 AND review_id = ANY($2::int[])`,
              [req.user.id, reviewIds]
            )
          : { rows: [] },
      ]);
      has_reviewed = myReview.rowCount > 0;
      for (const v of votes.rows) userVotes[v.review_id] = v.helpful;
    }

    return res.json({
      success: true,
      data: reviewsRes.rows.map((r) => ({
        ...r,
        user_vote: userVotes[r.id] ?? null,
      })),
      stats: {
        review_count: Number(stats.review_count),
        avg_rating:   stats.avg_rating ? Number(stats.avg_rating) : null,
        distribution: {
          5: Number(stats.stars_5),
          4: Number(stats.stars_4),
          3: Number(stats.stars_3),
          2: Number(stats.stars_2),
          1: Number(stats.stars_1),
        },
      },
      meta: {
        total,
        page:         parseInt(page),
        limit:        safeLimit,
        pages:        Math.ceil(total / safeLimit),
        has_reviewed,
      },
    });
  } catch (err) {
    console.error("[Reviews] getProductReviews:", err);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// getUserReviewForProduct — GET /api/reviews/my/:productId
// ─────────────────────────────────────────────────────────────────────────────
exports.getUserReviewForProduct = async (req, res) => {
  const { productId } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT r.*,
         COALESCE(
           (SELECT json_agg(
             json_build_object('id', ri.id, 'url', ri.url, 'public_id', ri.public_id)
             ORDER BY ri.position
           ) FROM review_images ri WHERE ri.review_id = r.id),
           '[]'
         ) AS images
       FROM reviews r
       WHERE r.product_id = $1 AND r.user_id = $2`,
      [productId, req.user.id]
    );
    return res.json({ success: true, data: rows[0] ?? null });
  } catch (err) {
    console.error("[Reviews] getUserReviewForProduct:", err);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// moderateReview — PATCH /api/reviews/:id/status  (admin)
// ─────────────────────────────────────────────────────────────────────────────
exports.moderateReview = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const valid = ["approved", "rejected", "flagged", "pending"];

  if (!valid.includes(status))
    return res.status(400).json({
      success: false,
      message: `status inválido. Valores permitidos: ${valid.join(", ")}`,
    });

  try {
    const { rows: prev } = await db.query(
      `SELECT r.id, r.status, r.product_id, p.owner_admin_id
       FROM reviews r
       JOIN products p ON p.id = r.product_id
       WHERE r.id = $1`,
      [id]
    );
    if (!prev.length)
      return res.status(404).json({ success: false, message: "Reseña no encontrada" });

    const review = prev[0];

    // Scope: superadmin ve todo; admin solo su tenant
    if (!req.isSuperAdmin && review.owner_admin_id !== req.adminId)
      return res.status(403).json({ success: false, message: "No autorizado" });

    const { rows } = await db.query(
      "UPDATE reviews SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
      [status, id]
    );

    // Refrescar stats si el estado 'approved' cambia (entra o sale)
    if (review.status !== status &&
        (review.status === "approved" || status === "approved")) {
      refreshStats();
    }

    emitDataUpdate("reviews", "updated", { id: parseInt(id), status }, req.adminId);

    return res.json({ success: true, message: "Estado actualizado", data: rows[0] });
  } catch (err) {
    console.error("[Reviews] moderateReview:", err);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// voteReview — POST /api/reviews/:id/vote
// ─────────────────────────────────────────────────────────────────────────────
exports.voteReview = async (req, res) => {
  const { id: reviewId } = req.params;
  const { helpful } = req.body;

  if (typeof helpful !== "boolean")
    return res.status(400).json({ success: false, message: "helpful debe ser true o false" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows: reviewRows } = await client.query(
      "SELECT id, user_id FROM reviews WHERE id = $1 AND status = 'approved'",
      [reviewId]
    );
    if (!reviewRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Reseña no encontrada" });
    }
    if (reviewRows[0].user_id === req.user.id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "No puedes votar tu propia reseña" });
    }

    // Upsert del voto
    await client.query(
      `INSERT INTO review_votes (review_id, user_id, helpful)
       VALUES ($1, $2, $3)
       ON CONFLICT (review_id, user_id) DO UPDATE SET helpful = EXCLUDED.helpful`,
      [reviewId, req.user.id, helpful]
    );

    // Recalcular helpful_count
    const { rows: updRows } = await client.query(
      `UPDATE reviews
         SET helpful_count = (
           SELECT COUNT(*) FROM review_votes
           WHERE review_id = $1 AND helpful = true
         )
       WHERE id = $1
       RETURNING helpful_count`,
      [reviewId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: helpful ? "Marcada como útil" : "Marcada como no útil",
      data: { helpful_count: Number(updRows[0].helpful_count), user_vote: helpful },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Reviews] voteReview:", err);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// reportReview — POST /api/reviews/:id/report
// ─────────────────────────────────────────────────────────────────────────────
exports.reportReview = async (req, res) => {
  const { id: reviewId } = req.params;
  const { reason, details } = req.body;

  if (!reason?.trim())
    return res.status(400).json({ success: false, message: "reason es requerido" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows: reviewRows } = await client.query(
      "SELECT id, user_id, status FROM reviews WHERE id = $1",
      [reviewId]
    );
    if (!reviewRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Reseña no encontrada" });
    }
    if (reviewRows[0].user_id === req.user.id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "No puedes reportar tu propia reseña" });
    }

    try {
      await client.query(
        `INSERT INTO review_reports (review_id, reported_by, reason, details)
         VALUES ($1, $2, $3, $4)`,
        [reviewId, req.user.id, reason.trim(), details?.trim() || null]
      );
    } catch (e) {
      if (e.code === "23505") {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: "Ya reportaste esta reseña" });
      }
      throw e;
    }

    // Auto-flagear si acumula 3+ reportes sin resolver
    const { rows: countRows } = await client.query(
      "SELECT COUNT(*) FROM review_reports WHERE review_id = $1 AND resolved = false",
      [reviewId]
    );
    if (parseInt(countRows[0].count) >= 3 && reviewRows[0].status !== "flagged") {
      await client.query(
        "UPDATE reviews SET status = 'flagged', updated_at = NOW() WHERE id = $1",
        [reviewId]
      );
    }

    await client.query("COMMIT");

    return res.json({ success: true, message: "Reseña reportada. Gracias por tu colaboración." });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Reviews] reportReview:", err);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  } finally {
    client.release();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// getPendingReviews — GET /api/reviews/admin/pending  (admin)
// ─────────────────────────────────────────────────────────────────────────────
exports.getPendingReviews = async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const safeLimit  = Math.min(parseInt(limit) || 20, 50);
  const safeOffset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

  const VALID_STATUSES = new Set(["pending", "flagged", "approved", "rejected"]);

  const conditions = [];
  const params     = [];

  // Status filter — "all" or absent means no status restriction
  if (status && status !== "all" && VALID_STATUSES.has(status)) {
    params.push(status);
    conditions.push(`r.status = $${params.length}`);
  }

  // Tenant scope
  if (!req.isSuperAdmin) {
    params.push(req.adminId);
    conditions.push(`p.owner_admin_id = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // Separate params for the counts query (tenant-only, no status filter)
  const countParams  = req.isSuperAdmin ? [] : [req.adminId];
  const countsTenant = req.isSuperAdmin ? "" : "WHERE p.owner_admin_id = $1";

  try {
    const [rowsRes, countRes, countsRes] = await Promise.all([
      db.query(
        `SELECT
           r.id, r.rating, r.title, r.body, r.status,
           r.is_verified_purchase, r.helpful_count, r.created_at,
           u.id   AS user_id,    u.name AS user_name,
           p.id   AS product_id, p.name AS product_name,
           (SELECT COUNT(*) FROM review_reports rr
            WHERE rr.review_id = r.id AND rr.resolved = false
           )::int AS report_count
         FROM reviews r
         JOIN users    u ON u.id = r.user_id
         JOIN products p ON p.id = r.product_id
         ${where}
         ORDER BY r.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, safeLimit, safeOffset]
      ),
      db.query(
        `SELECT COUNT(*) FROM reviews r
         JOIN products p ON p.id = r.product_id
         ${where}`,
        params
      ),
      // Tab badge counts — always all statuses, scoped to tenant
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE r.status = 'pending')  AS pending,
           COUNT(*) FILTER (WHERE r.status = 'flagged')  AS flagged,
           COUNT(*)                                       AS total
         FROM reviews r
         JOIN products p ON p.id = r.product_id
         ${countsTenant}`,
        countParams
      ),
    ]);

    const total = parseInt(countRes.rows[0].count);
    const c     = countsRes.rows[0];

    return res.json({
      success: true,
      data: rowsRes.rows,
      counts: {
        pending: Number(c.pending),
        flagged: Number(c.flagged),
        total:   Number(c.total),
      },
      meta: {
        total,
        page:  parseInt(page),
        limit: safeLimit,
        pages: Math.ceil(total / safeLimit),
      },
    });
  } catch (err) {
    console.error("[Reviews] getPendingReviews:", err);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// deleteReview — DELETE /api/reviews/:id
// Admin elimina cualquiera en su tenant; usuario solo la suya
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteReview = async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT r.id, r.user_id, r.product_id, p.owner_admin_id,
         COALESCE(
           json_agg(
             json_build_object('url', ri.url, 'public_id', ri.public_id)
           ) FILTER (WHERE ri.id IS NOT NULL),
           '[]'
         ) AS images
       FROM reviews r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN review_images ri ON ri.review_id = r.id
       WHERE r.id = $1
       GROUP BY r.id, p.owner_admin_id`,
      [id]
    );
    if (!rows.length)
      return res.status(404).json({ success: false, message: "Reseña no encontrada" });

    const review = rows[0];
    const isAdminRole = req.user.roles.some((r) =>
      ["admin", "superadmin", "gerente"].includes(r)
    );

    if (isAdminRole) {
      // Admin solo puede borrar reseñas de su tenant
      if (!req.isSuperAdmin && review.owner_admin_id !== req.adminId)
        return res.status(403).json({ success: false, message: "No autorizado" });
    } else {
      // Usuario solo puede borrar su propia reseña
      if (review.user_id !== req.user.id)
        return res.status(403).json({ success: false, message: "No autorizado" });
    }

    await db.query("DELETE FROM reviews WHERE id = $1", [id]);

    refreshStats();

    emitDataUpdate("reviews", "deleted", { id: parseInt(id) }, req.adminId ?? null);

    return res.json({
      success: true,
      message: "Reseña eliminada",
      data: {
        deleted_id: parseInt(id),
        // El frontend debe eliminar estas imágenes de Cloudinary
        cloudinary_public_ids: review.images
          .filter((img) => img.public_id)
          .map((img) => img.public_id),
      },
    });
  } catch (err) {
    console.error("[Reviews] deleteReview:", err);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
};
