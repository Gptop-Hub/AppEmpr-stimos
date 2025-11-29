// backend/routes/restore.js
const express = require('express');
const backupRouter = require('./backup');

const router = express.Router();

// Reusa exatamente o mesmo pipeline de middlewares do /backup/restore
const restoreMiddlewares = backupRouter.restoreMiddlewares || [];

if (!restoreMiddlewares.length) {
  // Se cair aqui, é porque backup.js não exportou o array — mas na versão corrigida ele exporta.
  throw new Error('restoreMiddlewares not exported by backup router');
}

router.post('/', ...restoreMiddlewares);

module.exports = router;