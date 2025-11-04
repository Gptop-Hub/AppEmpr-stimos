// backend/index.js
// inicializa banco e aplica migracoes
require('./models/database');

const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();

// LOG para arquivo se BACKEND_LOG vier do main
const BACKEND_LOG = process.env.BACKEND_LOG;
function blog(msg) {
  try {
    if (BACKEND_LOG) fs.appendFileSync(BACKEND_LOG, `[${new Date().toISOString()}] ${msg}\n`);
    console.log(msg);
  } catch (_) {}
}

// handlers globais para nao matar o processo silenciosamente
process.on('uncaughtException', (err) => {
  blog(`[uncaughtException] ${err && err.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  blog(`[unhandledRejection] ${reason}`);
});

// middlewares
app.use(express.json());

// CORS liberado para file:// e dev
app.use(cors({ origin: true, credentials: false }));

// rotas
const clienteRoutes = require('./routes/cliente');
const emprestimoRoutes = require('./routes/emprestimo');
const pagamentoRoutes = require('./routes/pagamento');
const renegociarRoutes = require('./routes/renegociar');
const parcelasRoutes = require('./routes/parcelas');
const backupRoutes = require('./routes/backup');
const restoreRoutes = require('./routes/restore');

app.use('/clientes', clienteRoutes);
app.use('/emprestimos', emprestimoRoutes);
app.use('/pagamentos', pagamentoRoutes);
app.use('/renegociar', renegociarRoutes);
app.use('/parcelas', parcelasRoutes);
app.use('/backup', backupRoutes);
app.use('/restore', restoreRoutes);

// health
app.get('/health', (req, res) => {
  res.json({ ok: true, when: new Date().toISOString(), message: 'Backend ativo e respondendo!' });
});

// inicializa servidor
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.BACKEND_PORT || 3001);

app.listen(PORT, HOST, () => {
  blog(`[backend] Servidor rodando em http://${HOST}:${PORT}`);
  blog(`[backend] APP_DATA_DIR=${process.env.APP_DATA_DIR || '(nao definido)'}`);
});
