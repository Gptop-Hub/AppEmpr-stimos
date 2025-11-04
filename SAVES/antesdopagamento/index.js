// inicializa banco e aplica migrações
require('./models/database');

const express = require('express');
const cors = require('cors');
const app = express();

// rotas
const clienteRoutes    = require('./routes/cliente');
const emprestimoRoutes = require('./routes/emprestimo');
const pagamentoRoutes  = require('./routes/pagamento');
const renegociarRoutes = require('./routes/renegociar');
const parcelasRoutes   = require('./routes/parcelas');
const backupRoutes     = require('./routes/backup');
const restoreRoutes    = require('./routes/restore');  // ✅ nova rota separada

// middlewares
app.use(cors());
app.use(express.json());

// endpoints
app.use('/clientes',    clienteRoutes);
app.use('/emprestimos', emprestimoRoutes);
app.use('/pagamentos',  pagamentoRoutes);
app.use('/renegociar',  renegociarRoutes);
app.use('/parcelas',    parcelasRoutes);
app.use('/backup',      backupRoutes);
app.use('/restore',     restoreRoutes);  // ✅ registrando rota de restore

// inicializa servidor
app.listen(3001, () => {
  console.log('Servidor rodando na porta 3001');
});