const crypto = require('node:crypto');
const { promisify } = require('node:util');
const sqlite3 = require('sqlite3');

const scrypt = promisify(crypto.scrypt);
const PROTECOES = Object.freeze([
  ['editar_cliente', 'Editar cliente', false],
  ['excluir_cliente', 'Excluir cliente', false],
  ['editar_emprestimo', 'Salvar alterações em um empréstimo', false],
  ['excluir_emprestimo', 'Excluir um empréstimo', true],
  ['excluir_todos_emprestimos', 'Excluir todos os empréstimos', true],
  ['adicionar_juros_parcela', 'Adicionar juros em uma parcela futura', false],
  ['excluir_despesa', 'Excluir uma despesa', true],
  ['apagar_todos_dados', 'Apagar todos os dados do sistema', true],
]);
const HASH_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function falha(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
function senhaValida(senha) {
  return typeof senha === 'string' && senha.trim().length > 0 && Buffer.byteLength(senha) <= 1024;
}
async function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = await scrypt(senha, salt, 64, HASH_OPTIONS);
  return `scrypt$32768$8$3$${salt}$${digest.toString('hex')}`;
}
async function conferirHash(senha, hash) {
  if (!senhaValida(senha) || typeof hash !== 'string') return false;
  const [alg, n, r, p, salt, digest] = hash.split('$');
  if (alg !== 'scrypt' || n !== '32768' || r !== '8' || p !== '3' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(digest)) return false;
  const calculado = await scrypt(senha, salt, 64, HASH_OPTIONS);
  return crypto.timingSafeEqual(calculado, Buffer.from(digest, 'hex'));
}
function publico(row) {
  const definicao = PROTECOES.find(([chave]) => chave === row.chave);
  return { chave: row.chave, nome: definicao[1], ativo: Boolean(row.ativo), temSenha: Boolean(row.senha_hash), criadoEm: row.criado_em, atualizadoEm: row.atualizado_em };
}

// Banco de configurações separado: restaurar um backup financeiro não restaura senhas antigas.
function criarSegurancaService({ dbPath, senhasLegadas, tokenTtlMs = 120000 } = {}) {
  let db;
  let inicializacao;
  const tokens = new Map();
  const tentativas = new Map();
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
  const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));

  function inicializar() {
    if (!inicializacao) inicializacao = (async () => {
      db = await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(dbPath, err => err ? reject(err) : resolve(connection));
      });
      db.configure('busyTimeout', 5000);
      await run(`CREATE TABLE IF NOT EXISTS seguranca_protecoes (
        chave TEXT PRIMARY KEY,
        ativo INTEGER NOT NULL CHECK(ativo IN (0,1)),
        senha_hash TEXT,
        revisao INTEGER NOT NULL DEFAULT 1,
        criado_em TEXT NOT NULL,
        atualizado_em TEXT NOT NULL,
        CHECK(ativo = 0 OR senha_hash IS NOT NULL)
      )`);
      const pendentes = [];
      for (const definicao of PROTECOES) {
        if (!await get('SELECT chave FROM seguranca_protecoes WHERE chave = ?', [definicao[0]])) pendentes.push(definicao);
      }
      for (const [chave, , administrativa] of pendentes) {
        const legada = administrativa ? process.env.ADMIN_PASSWORD || '1otimodia' : '1otimodia';
        if (!senhasLegadas && !senhaValida(legada)) throw falha('Senha legada administrativa inválida. Corrija ADMIN_PASSWORD antes de migrar; nenhuma senha foi inventada.', 503);
      }
      for (const [chave, , administrativa] of pendentes) {
        const senha = senhasLegadas ? senhasLegadas[chave] : (administrativa ? process.env.ADMIN_PASSWORD || '1otimodia' : '1otimodia');
        // Ausência de senha conhecida nunca cria proteção ligada sem senha utilizável.
        const hash = senhaValida(senha) ? await hashSenha(senha) : null;
        const agora = new Date().toISOString();
        await run('INSERT OR IGNORE INTO seguranca_protecoes VALUES(?,?,?,?,?,?)', [chave, hash ? 1 : 0, hash, 1, agora, agora]);
      }
    })();
    return inicializacao;
  }
  async function obter(chave) {
    if (!PROTECOES.some(([key]) => key === chave)) throw falha('Proteção desconhecida.', 404);
    await inicializar();
    const row = await get('SELECT * FROM seguranca_protecoes WHERE chave = ?', [chave]);
    if (!row) throw falha('Configuração de segurança indisponível.', 503);
    return row;
  }
  async function conferir(row, senha) {
    const agora = Date.now();
    const tentativa = tentativas.get(row.chave);
    if (tentativa && tentativa.ate > agora && tentativa.falhas >= 8) throw falha('Muitas tentativas. Aguarde um minuto.', 429);
    // Reservar a tentativa antes do hash assíncrono para não perder contagem em chamadas paralelas.
    const falhas = tentativa && tentativa.ate > agora ? tentativa.falhas + 1 : 1;
    tentativas.set(row.chave, { falhas, ate: tentativa && tentativa.ate > agora ? tentativa.ate : agora + 60000 });
    if (!await conferirHash(senha, row.senha_hash)) {
      throw falha('Senha incorreta.', 401);
    }
    tentativas.delete(row.chave);
  }
  async function atualizar(row, ativo, hash) {
    const result = await run(`UPDATE seguranca_protecoes SET ativo=?, senha_hash=?, revisao=revisao+1, atualizado_em=? WHERE chave=? AND revisao=?`, [ativo ? 1 : 0, hash, new Date().toISOString(), row.chave, row.revisao]);
    if (result.changes !== 1) throw falha('A proteção foi alterada em outra janela. Atualize e tente novamente.', 409);
    return publico(await obter(row.chave));
  }
  async function listar() {
    return Promise.all(PROTECOES.map(async ([chave]) => publico(await obter(chave))));
  }
  async function protecaoAtiva(chave) { return Boolean((await obter(chave)).ativo); }
  async function estado(chave) { return publico(await obter(chave)); }
  async function definirSenha(chave, { senhaAtual, novaSenha, confirmacao, ativar = false } = {}) {
    if (!senhaValida(novaSenha)) throw falha('Informe uma nova senha não vazia, com até 1024 bytes.');
    if (novaSenha !== confirmacao) throw falha('A confirmação da nova senha está diferente.');
    if (typeof ativar !== 'boolean') throw falha('Ativação inválida.');
    const row = await obter(chave);
    if (row.senha_hash) await conferir(row, senhaAtual);
    return atualizar(row, Boolean(row.ativo) || ativar, await hashSenha(novaSenha));
  }
  async function alterarEstado(chave, { ativo, senhaAtual } = {}) {
    if (typeof ativo !== 'boolean') throw falha('Estado inválido.');
    const row = await obter(chave);
    if (ativo && !row.senha_hash) throw falha('Defina uma senha antes de ligar a proteção.', 409);
    if (!ativo && row.ativo) await conferir(row, senhaAtual);
    if (Boolean(row.ativo) === ativo) return publico(row);
    return atualizar(row, ativo, row.senha_hash);
  }
  async function validarSenhaProtecao(chave, senha) {
    const row = await obter(chave);
    await conferir(row, senha);
    for (const [token, info] of tokens) if (info.ate <= Date.now()) tokens.delete(token);
    if (tokens.size >= 1000) throw falha('Limite de autorizações temporárias. Aguarde e tente novamente.', 429);
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, { chave, revisao: row.revisao, ate: Date.now() + tokenTtlMs });
    return { token, expiraEmMs: tokenTtlMs };
  }
  async function autorizar(chave, token, senha) {
    const row = await obter(chave);
    if (!row.ativo) return true;
    const info = tokens.get(token);
    if (info && info.chave === chave && info.revisao === row.revisao && info.ate > Date.now()) return true;
    // Compatibilidade para os consumidores legados de API; valida o hash específico, não ADMIN_PASSWORD.
    if (senha !== undefined) { await conferir(row, senha); return true; }
    throw falha('Esta operação exige a senha da proteção correspondente.', 401);
  }
  async function fechar() {
    if (inicializacao) await inicializacao.catch(() => {});
    if (!db) return;
    await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
    db = null;
    inicializacao = null;
    tokens.clear();
    tentativas.clear();
  }
  return { inicializar, listar, estado, protecaoAtiva, definirSenha, alterarEstado, validarSenhaProtecao, autorizar, fechar };
}

let singleton;
function getSegurancaService() {
  if (!singleton) singleton = criarSegurancaService({ dbPath: require('../utils/paths').getSecurityDbPath() });
  return singleton;
}
module.exports = { PROTECOES, criarSegurancaService, getSegurancaService, conferirHash };
