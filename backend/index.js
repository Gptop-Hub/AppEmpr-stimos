const express = require('express'); 
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const paths = require('./utils/paths');

const envFiles = [
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', '.env'),
];

for (const envFile of envFiles) {
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile, override: false });
  }
}

// inicializa banco
const database = require('./models/database');

// MIGRAÇÕES
const { runMigrations } = require('./models/migrations');
const { gerarNotificacoesParaData } = require('./services/notificacoesService');

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

// ================================
// HANDLERS GLOBAIS
// ================================
process.on('uncaughtException', (err) => {
  blog(`[uncaughtException] ${err && err.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  blog(`[unhandledRejection] ${reason}`);
});

// ================================
// MIDDLEWARES
// ================================
app.use(express.json());
app.use(cors({
  origin: true,
  credentials: false,
  exposedHeaders: [
    'Content-Disposition',
    'X-Backup-Format-Version',
    'X-Backup-Photo-Count',
  ],
}));

blog('[backend] Middlewares carregados');

// ================================
// ROTAS
// ================================
const clienteRoutes     = require('./routes/cliente');
const emprestimoRoutes  = require('./routes/emprestimo');
const pagamentoRoutes   = require('./routes/pagamento');
const renegociarRoutes  = require('./routes/renegociar');
const parcelasRoutes    = require('./routes/parcelas');
const backupRoutes      = require('./routes/backup');
const restoreRoutes     = require('./routes/restore');
const notificacoesRoutes = require('./routes/notificacoes');
const relatorioRoutes = require('./routes/relatorio');
const relatoriosRoutes = require('./routes/relatorios');
const fluxoCaixaRoutes = require('./routes/fluxoCaixa');
const caixaRoutes = require('./routes/caixa');
const assistenteRoutes = require('./routes/assistente');
const sistemaRoutes = require('./routes/sistema');
const vencidosRoutes = require('./routes/vencidos');

blog('[backend] Arquivos de rotas importados');

// registro das rotas
app.use('/clientes', clienteRoutes);
app.use('/emprestimos', emprestimoRoutes);
app.use('/pagamentos', pagamentoRoutes);
app.use('/renegociar', renegociarRoutes);
app.use('/parcelas', parcelasRoutes);
app.use('/backup', backupRoutes);
app.use('/restore', restoreRoutes);
app.use(relatorioRoutes);
app.use('/relatorios', relatoriosRoutes);
app.use('/fluxo-caixa', fluxoCaixaRoutes);
app.use('/relatorio/caixa', fluxoCaixaRoutes); // compatibilidade com endpoint legado
app.use('/caixa', caixaRoutes);
app.use('/assistente', assistenteRoutes);
app.use('/sistema', sistemaRoutes);
app.use('/seguranca', require('./routes/seguranca').criarSegurancaRouter());
app.use('/vencidos', vencidosRoutes);

blog('[backend] Rotas principais registradas');

// 👉 LOG CRÍTICO
app.use('/notificacoes', notificacoesRoutes);
blog('[backend] ROTA /notificacoes REGISTRADA');

// ================================
// HEALTH
// ================================
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'app-emprestimos-backend',
    when: new Date().toISOString(),
    message: 'Backend ativo e respondendo!',
    dbPath: typeof database.getDbPath === 'function'
      ? database.getDbPath()
      : paths.getDbPath(),
    backupsDir: paths.getBackupsDir(),
    appDataDir: paths.getAppDataDir(),
  });
});

blog('[backend] Rota /health registrada');

// ================================
// SERVER
// ================================
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.BACKEND_PORT || 3001);
const NOTIF_SCHED_DEFAULT_MS = 60 * 60 * 1000; // 1 hora

function startNotificacoesScheduler() {
  const flag = (process.env.NOTIFICACOES_SCHEDULER || '').toLowerCase();
  if (flag === 'off') {
    blog('[notificacoes/scheduler] Desativado via NOTIFICACOES_SCHEDULER=off');
    return;
  }

  const intervalMs =
    Number(process.env.NOTIFICACOES_SCHEDULER_MS) > 0
      ? Number(process.env.NOTIFICACOES_SCHEDULER_MS)
      : NOTIF_SCHED_DEFAULT_MS;

  const run = async () => {
    const d = new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    const hojeISO = local.toISOString().slice(0, 10);
    blog(`[notificacoes/scheduler] Gerando notificacoes para ${hojeISO}...`);
    try {
      const resultado = await gerarNotificacoesParaData(hojeISO);
      blog(`[notificacoes/scheduler] OK: ${JSON.stringify(resultado)}`);
    } catch (err) {
      blog(`[notificacoes/scheduler] ERRO: ${err && err.message || err}`);
    }
  };

  blog(
    `[notificacoes/scheduler] Ativo (a cada ${Math.round(
      intervalMs / 60000
    )} minuto(s))`
  );
  run();
  setInterval(run, intervalMs);
}

async function start() {
  try {
    blog('[backend] Rodando migrações do banco...');
    await runMigrations();
    await require('./services/segurancaService').getSegurancaService().inicializar();
    blog('[backend] Migrações concluídas.');

    app.listen(PORT, HOST, () => {
      blog(`[backend] Servidor rodando em http://${HOST}:${PORT}`);
      blog(`[backend] APP_DATA_DIR=${process.env.APP_DATA_DIR || '(nao definido)'}`);
      blog(`[backend] DB_PATH=${paths.getDbPath()}`);
      blog(`[backend] BACKUPS_DIR=${paths.getBackupsDir()}`);
      startNotificacoesScheduler();
    });
  } catch (err) {
    blog(`[backend] ERRO AO RODAR MIGRAÇÕES: ${err}`);
    process.exit(1);
  }
}

start();
