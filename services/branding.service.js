'use strict';
const db = require('../config/db');

const DEFAULTS = {
  businessName:   'Tu negocio',
  logoUrl:        null,
  tagline:        null,
  primaryColor:   '#3B82F6',
  secondaryColor: '#1E40AF',
  accentColor:    '#F59E0B',
  businessEmail:  null,
  businessPhone:  null,
  address:        null,
};

const _cache = new Map(); // key: ownerAdminId → { data, expiresAt }
const TTL    = 5 * 60 * 1000; // 5 min

async function getAdminBranding(ownerAdminId) {
  if (!ownerAdminId) return { ...DEFAULTS };

  const hit = _cache.get(ownerAdminId);
  if (hit && Date.now() < hit.expiresAt) return hit.data;

  const { rows } = await db.query(
    `SELECT business_name, logo_url, tagline,
            primary_color, secondary_color, accent_color,
            business_email, business_phone, address
     FROM admin_profiles WHERE user_id = $1`,
    [ownerAdminId]
  );

  const r = rows[0] ?? {};
  const data = {
    businessName:   r.business_name   ?? DEFAULTS.businessName,
    logoUrl:        r.logo_url        ?? DEFAULTS.logoUrl,
    tagline:        r.tagline         ?? DEFAULTS.tagline,
    primaryColor:   r.primary_color   ?? DEFAULTS.primaryColor,
    secondaryColor: r.secondary_color ?? DEFAULTS.secondaryColor,
    accentColor:    r.accent_color    ?? DEFAULTS.accentColor,
    businessEmail:  r.business_email  ?? DEFAULTS.businessEmail,
    businessPhone:  r.business_phone  ?? DEFAULTS.businessPhone,
    address:        r.address         ?? DEFAULTS.address,
  };

  _cache.set(ownerAdminId, { data, expiresAt: Date.now() + TTL });
  return data;
}

// Call this from adminProfile.controller.js after a profile update to avoid stale cache
function invalidateBrandingCache(ownerAdminId) {
  _cache.delete(ownerAdminId);
}

module.exports = { getAdminBranding, invalidateBrandingCache };