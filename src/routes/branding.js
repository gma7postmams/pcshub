const express = require('express');
const db = require('../db');
const { asyncH } = require('../middleware');
const { THEMES, THEME_KEYS } = require('../themes');

const router = express.Router();

// Public: used by login page, nav, manifest
router.get('/', asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT key, value FROM app_settings WHERE key IN ('app_name','tagline','theme','accent_color','logo_path','logo_dark_path')`
  );
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.set('Cache-Control', 'no-cache');
  res.json({
    app_name: s.app_name || 'PULSE',
    tagline: s.tagline || '',
    theme: THEME_KEYS.includes(s.theme) ? s.theme : 'midnight',
    accent_color: s.accent_color || '', // optional override of the theme accent
    themes: THEMES,
    // One upload is used in both modes; two uploads give each mode its own. With none, the built-in PULSE logo (black lettering for light, white for dark).
    logo_url: s.logo_path || s.logo_dark_path || '/brand/pulse-logo.png',
    logo_dark_url: s.logo_dark_path || s.logo_path || '/brand/pulse-logo-dark.png',
    logo_custom: !!(s.logo_path || s.logo_dark_path),
    logo_light_set: !!s.logo_path,
    logo_dark_set: !!s.logo_dark_path,
  });
}));

module.exports = router;
