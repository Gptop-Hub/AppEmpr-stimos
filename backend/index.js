const express = require('express');
const cors = require('cors');
const fs = require('fs');
const paths = require('./utils/paths');

// inicializa banco
const database = require('./models/database');

// MIGRAÇÕES (NOVO)
const { runMigrations } = require('./models/migrations');  // 👈 aqui está o caminho correto

const app = express();

// LOG para arquivo se BACKEND_LOG vier do main
const BACKEND_LOG = process.env.BACKEND_LOG;
function blog(msg) {
  try {
    if (BACKEND_LOG) {
      fs.appendFileSync(
        BACKEND_LOG,
        `[${new Date().toISOString()}] ${msg}\n`
      );
    }
    console.log(msg);
  } catch (_) {}
}

// handlers globais para não matar o processo silenciosamente
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
const clienteRoutes     = require('./routes/cliente');
const emprestimoRoutes  = require('./routes/emprestimo');
const pagamentoRoutes   = require('./routes/pagamento');
const renegociarRoutes  = require('./routes/renegociar');
const parcelasRoutes    = require('./routes/parcelas');
const backupRoutes      = require('./routes/backup');
const restoreRoutes     = require('./routes/restore');

app.use('/clientes', clienteRoutes);
app.use('/emprestimos', emprestimoRoutes);
app.use('/pagamentos', pagamentoRoutes);
app.use('/renegociar', renegociarRoutes);
app.use('/parcelas', parcelasRoutes);
app.use('/backup', backupRoutes);
app.use('/restore', restoreRoutes);

// Rota health
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    when: new Date().toISOString(),
    message: 'Backend ativo e respondendo!',
    dbPath: typeof database.getDbPath === 'function'
      ? database.getDbPath()
      : paths.getDbPath(),
    backupsDir: paths.getBackupsDir(),
    appDataDir: paths.getAppDataDir(),
  });
});

// inicializa servidor
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.BACKEND_PORT || 3001);

// 👇 NOVO: start async, roda migrações antes do listen
async function start() {
  try {
    blog('[backend] Rodando migrações do banco...');
    await runMigrations(); // 👈 roda as migrações ANTES de iniciar servidor
    blog('[backend] Migrações concluídas com sucesso.');

    app.listen(PORT, HOST, () => {
      blog(`[backend] Servidor rodando em http://${HOST}:${PORT}`);
      blog(`[backend] APP_DATA_DIR=${process.env.APP_DATA_DIR || '(nao definido)'}`);
      blog(`[backend] DB_PATH=${paths.getDbPath()}`);
      blog(`[backend] BACKUPS_DIR=${paths.getBackupsDir()}`);
    });
  } catch (err) {
    blog(`[backend] ERRO AO RODAR MIGRAÇÕES: ${err && err.stack || err}`);
    // Melhor falhar do que rodar sem as colunas que o backend agora espera
    process.exit(1);
  }
}

start();