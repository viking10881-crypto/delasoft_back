// services/providers/whatsapp.provider.js
// Provider-agnostic dispatcher. Select via WHATSAPP_PROVIDER env var:
//   'meta_cloud' (default) — native fetch, no extra deps
//   'twilio'               — requires `twilio` npm package
'use strict';

function _normalizePhone(rawPhone, rawCountryCode) {
  const digits = String(rawPhone).replace(/\D/g, '');
  const code   = String(rawCountryCode || '57').replace(/\D/g, '');
  return digits.startsWith(code) ? digits : code + digits;
}

async function _sendMetaCloud(phone, message) {
  const phoneNumberId = process.env.META_WA_PHONE_NUMBER_ID;
  const accessToken   = process.env.META_WA_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    return {
      success: false,
      error: 'Variables META_WA_PHONE_NUMBER_ID y META_WA_ACCESS_TOKEN no configuradas',
    };
  }

  try {
    const resp = await fetch(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to:                phone,
          type:              'text',
          text:              { body: message },
        }),
      }
    );

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return {
        success: false,
        error: data?.error?.message ?? `HTTP ${resp.status}`,
      };
    }

    return {
      success:           true,
      providerMessageId: data?.messages?.[0]?.id ?? null,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function _sendTwilio(phone, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_WHATSAPP_FROM;

  if (!accountSid || !authToken || !from) {
    return { success: false, error: 'Credenciales de Twilio no configuradas' };
  }

  try {
    // Dynamic require — twilio is an optional dependency
    const twilio = require('twilio'); // eslint-disable-line import/no-extraneous-dependencies
    const client = twilio(accountSid, authToken);
    const msg = await client.messages.create({
      from: `whatsapp:${from}`,
      to:   `whatsapp:${phone}`,
      body: message,
    });
    return { success: true, providerMessageId: msg.sid };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Sends a WhatsApp text message.
 * @param {string} rawPhone       - destination phone number (digits, with or without country code)
 * @param {string} message        - text body
 * @param {string} [countryCode]  - default '57' (Colombia)
 * @returns {{ success: boolean, providerMessageId?: string, error?: string }}
 */
async function send(rawPhone, message, countryCode = '57') {
  const phone    = _normalizePhone(rawPhone, countryCode);
  const provider = process.env.WHATSAPP_PROVIDER || 'meta_cloud';

  if (provider === 'twilio') return _sendTwilio(phone, message);
  return _sendMetaCloud(phone, message);
}

module.exports = { send };
