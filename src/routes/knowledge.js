const express = require('express');

// Mounted behind requirePageAccess('/knowledge') => any group that has the Knowledge Base page checked.
//
// Knowledge Base content/structure is NOT defined yet (to be built).
// The page and its group lock are in place. When the content model is specified:
//   1. add a table (e.g. knowledge_articles) to src/schema.sql
//   2. implement list / read / write handlers below
//   3. add a role action (e.g. 'knowledge.write') in src/permissions.js and guard writes with requireAction()
const router = express.Router();

router.get('/meta', (req, res) => res.json({ ready: false }));

router.get('/', (req, res) => res.json([]));

module.exports = router;
