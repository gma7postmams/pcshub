const express = require('express');
const db = require('../db');
const { asyncH } = require('../middleware');
const { THEMES, THEME_KEYS } = require('../themes');

const router = express.Router();

// Public: used by login page, nav, manifest
router.get('/', asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT key, value FROM app_settings WHERE key IN ('app_name','tagline','theme','accent_color','logo_path')`
  );
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.set('Cache-Control', 'no-cache');
  res.json({
    app_name: s.app_name || 'Promotional Content Hub',
    tagline: s.tagline || '',
    theme: THEME_KEYS.includes(s.theme) ? s.theme : 'midnight',
    accent_color: s.accent_color || '', // optional override of the theme accent
    themes: THEMES,
    logo_url: s.logo_path || null,
  });
}));

module.exports = router;
