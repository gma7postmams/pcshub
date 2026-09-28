const express = require('express');

// Mounted behind requirePageAccess('/workload') => Admin, Manager only.
//
// Work Load Tracker fields are NOT defined yet (to be built).
// The page, its group lock and the workload_items table (identity/audit columns only)
// are in place. When fields are specified:
//   1. add the columns to workload_items in src/schema.sql
//   2. add them to FIELDS below and implement list + batch save (Table / Excel modes)
//   3. guard writes with requireAction('workload.write')
const router = express.Router();

const FIELDS = []; // e.g. { key: 'task', label: 'Task', type: 'text', required: true }

router.get('/meta', (req, res) => res.json({ ready: FIELDS.length > 0, fields: FIELDS }));

router.get('/', (req, res) => res.json([]));

module.exports = router;
