// routes/cliente.js
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const { exigirProtecao } = require('../middleware/protecao');
const db = require('../models/database');
const { touchAtividade } = require('../utils/touchAtividade');
const { getClientPhotosDir } = require('../utils/paths');
const { gerarNotificacoesParaData } = require('../services/notificacoesService');
const { clienteIdValido, salvarEdicaoCliente } = require('../services/clienteEdicaoService');
const { runAsync } = require('../utils/sqliteAsync');
const { ensureActionContractReady } = require('../services/actionIdentityService');
const { ensureEntityIdentityV1 } = require('../services/entityIdentityService');
const { capturarEstadoCliente, registrarAcaoCliente } = require('../services/clienteActionService');
const { ACTION_TYPES } = require('../services/actionTypeContract');
const {
  adicionarTelefoneCliente,
  atualizarMalPagadorCliente,
  atualizarPreferenciaCobrancaCliente,
  atualizarFotoCliente,
} = require('../services/clienteActionMutationService');

const MAX_FOTO_BYTES = 5 * 1024 * 1024;
const MIME_FOTOS_PERMITIDOS = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const uploadFoto = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: MAX_FOTO_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    const mime = String(file && file.mimetype ? file.mimetype : '').toLowerCase();
    if (MIME_FOTOS_PERMITIDOS.has(mime)) {
      callback(null, true);
      return;
    }

    const error = new Error('Formato de imagem nao permitido.');
    error.code = 'INVALID_IMAGE_TYPE';
    callback(error);
  },
});

/**
 * Helper: limpa CPF (remove qualquer não-dígito)
 */
function cleanCpf(cpf) {
  if (!cpf && cpf !== 0) return '';
  return String(cpf).replace(/\D/g, '');
}

function cleanPhoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function normalizeTelefoneForCompare(phone) {
  return cleanPhoneDigits(phone);
}

function formatTelefoneBrasil(phoneRaw) {
  const digits = cleanPhoneDigits(phoneRaw);
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  return null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function parseMalPagador(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (value === 1) return 1;
    if (value === 0) return 0;
  }

  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'sim', 'yes', 'on'].includes(text)) return 1;
  if (['0', 'false', 'nao', 'não', 'no', 'off', ''].includes(text)) return 0;
  return null;
}

function parseReceberNotificacoesCobranca(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (value === 1) return 1;
    if (value === 0) return 0;
  }

  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'sim', 'yes', 'on'].includes(text)) return 1;
  if (['0', 'false', 'nao', 'não', 'no', 'off'].includes(text)) return 0;
  return null;
}

function detectarFormatoImagem(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { extension: 'png', mime: 'image/png' };
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { extension: 'jpg', mime: 'image/jpeg' };
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { extension: 'webp', mime: 'image/webp' };
  }

  return null;
}

function mimeConfereComFormato(mimeRecebido, formato) {
  const mime = String(mimeRecebido || '').toLowerCase();
  if (!formato) return false;
  if (formato.mime === 'image/jpeg') {
    return mime === 'image/jpeg' || mime === 'image/jpg';
  }
  return mime === formato.mime;
}

function resolverCaminhoFoto(nomeArquivo) {
  const nome = String(nomeArquivo || '').trim();
  if (!/^cliente-\d+-[a-f0-9-]+\.(?:jpg|png|webp)$/i.test(nome)) return null;
  if (path.basename(nome) !== nome) return null;
  return path.join(getClientPhotosDir(), nome);
}

async function removerArquivoFoto(nomeArquivo) {
  const arquivo = resolverCaminhoFoto(nomeArquivo);
  if (!arquivo) return;

  try {
    await fs.promises.unlink(arquivo);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('Erro ao remover arquivo de foto do cliente:', err.message);
    }
  }
}

function receberFoto(req, res, next) {
  uploadFoto.single('foto')(req, res, (err) => {
    if (!err) {
      next();
      return;
    }

    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'A foto deve ter no maximo 5 MB.' });
      return;
    }
    if (err.code === 'INVALID_IMAGE_TYPE') {
      res.status(415).json({ error: 'Use uma imagem JPG, PNG ou WebP.' });
      return;
    }

    console.error('Erro ao receber foto do cliente:', err.message);
    res.status(400).json({ error: 'Nao foi possivel receber a foto.' });
  });
}

function normalizarClienteParaResposta(cliente) {
  if (!cliente) return cliente;
  const fotoCliente = String(cliente.foto_cliente || '').trim() || null;
  return {
    ...cliente,
    mal_pagador: Number(cliente.mal_pagador || 0) === 1 ? 1 : 0,
    foto_cliente: fotoCliente,
    foto_url: fotoCliente
      ? `/clientes/${encodeURIComponent(cliente.id)}/foto?v=${encodeURIComponent(fotoCliente)}`
      : null,
  };
}

function mergeTelefones(principal, extras = []) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const t = String(value || '').trim();
    if (!t) return;
    const norm = normalizeTelefoneForCompare(t) || t;
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(t);
  };

  push(principal);
  (extras || []).forEach(push);
  return out;
}

function anexarTelefonesExtras(clientes, callback) {
  const lista = Array.isArray(clientes) ? clientes : [];
  if (lista.length === 0) {
    callback(null, []);
    return;
  }

  const ids = lista
    .map((c) => Number(c && c.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) {
    const semExtras = lista.map((c) => ({
      ...c,
      telefones_extras: [],
      telefones: mergeTelefones(c && c.telefone, []),
    }));
    callback(null, semExtras);
    return;
  }

  const placeholders = ids.map(() => '?').join(',');
  db.all(
    `SELECT id, cliente_id, telefone
       FROM clientes_telefones
      WHERE cliente_id IN (${placeholders})
      ORDER BY id ASC`,
    ids,
    (err, rows) => {
      if (err) {
        if (String(err.message || '').toLowerCase().includes('no such table')) {
          const fallback = lista.map((c) => ({
            ...c,
            telefones_extras: [],
            telefones: mergeTelefones(c && c.telefone, []),
          }));
          callback(null, fallback);
          return;
        }
        callback(err);
        return;
      }

      const extrasPorCliente = new Map();
      (rows || []).forEach((r) => {
        const clienteId = Number(r && r.cliente_id);
        if (!Number.isFinite(clienteId)) return;
        if (!extrasPorCliente.has(clienteId)) extrasPorCliente.set(clienteId, []);
        extrasPorCliente.get(clienteId).push(String(r && r.telefone ? r.telefone : '').trim());
      });

      const comExtras = lista.map((c) => {
        const clienteId = Number(c && c.id);
        const extras = Number.isFinite(clienteId)
          ? extrasPorCliente.get(clienteId) || []
          : [];
        return {
          ...c,
          telefones_extras: extras,
          telefones: mergeTelefones(c && c.telefone, extras),
        };
      });

      callback(null, comExtras);
    }
  );
}

function enviarClientePorId(id, res, status = 200) {
  db.get('SELECT * FROM clientes WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('Erro ao buscar cliente:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar cliente.' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Cliente nao encontrado.' });
    }
    anexarTelefonesExtras([row], (extraErr, clientesComTelefones) => {
      if (extraErr) {
        console.error('Erro ao buscar telefones extras do cliente:', extraErr.message);
        return res.status(500).json({ error: 'Erro ao buscar cliente.' });
      }
      const cliente = (clientesComTelefones && clientesComTelefones[0]) || row;
      return res.status(status).json(normalizarClienteParaResposta(cliente));
    });
  });
}

/**
 * Buscar todos os clientes
 */
router.get('/', (req, res) => {
  db.all('SELECT * FROM clientes', (err, rows) => {
    if (err) {
      console.error('Erro ao buscar clientes:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar clientes.' });
    }
    anexarTelefonesExtras(rows || [], (extraErr, clientesComTelefones) => {
      if (extraErr) {
        console.error('Erro ao buscar telefones extras dos clientes:', extraErr.message);
        return res.status(500).json({ error: 'Erro ao buscar clientes.' });
      }
      res.json((clientesComTelefones || []).map(normalizarClienteParaResposta));
    });
  });
});

/**
 * Checar se ID existe (rota para validação no frontend)
 * GET /clientes/check-id/:id
 */
router.get('/check-id/:id', (req, res) => {
  const id = req.params.id;
  db.get('SELECT id FROM clientes WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('Erro ao checar ID:', err.message);
      return res.status(500).json({ error: 'Erro no servidor.' });
    }
    res.json({ exists: !!row });
  });
});

/**
 * Checar se CPF já existe
 * GET /clientes/check-cpf?cpf=...
 */
router.get('/check-cpf', (req, res) => {
  const cpfRaw = req.query.cpf;
  if (!cpfRaw) return res.status(400).json({ error: 'CPF obrigatório' });

  const cpf = cleanCpf(cpfRaw);
  if (!cpf) return res.status(400).json({ error: 'CPF inválido' });

  // compara removendo '.' e '-' da coluna cpf
  db.get(
    `SELECT id FROM clientes WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? LIMIT 1`,
    [cpf],
    (err, row) => {
      if (err) {
        console.error('[ERRO] GET /clientes/check-cpf', err.message);
        return res.status(500).json({ error: 'Erro interno' });
      }
      res.json({ exists: !!row, id: row ? row.id : null });
    }
  );
});

/**
 * Exibir a foto atual de um cliente sem revelar o caminho local do arquivo.
 */
router.get('/:id/foto', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de cliente invalido.' });
  }

  db.get('SELECT foto_cliente FROM clientes WHERE id = ?', [id], (err, cliente) => {
    if (err) {
      console.error('Erro ao buscar foto do cliente:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar foto do cliente.' });
    }
    if (!cliente) {
      return res.status(404).json({ error: 'Cliente nao encontrado.' });
    }

    const arquivo = resolverCaminhoFoto(cliente.foto_cliente);
    if (!arquivo) {
      return res.status(404).json({ error: 'Cliente sem foto cadastrada.' });
    }

    fs.stat(arquivo, (statErr, stats) => {
      if (statErr || !stats || !stats.isFile()) {
        return res.status(404).json({ error: 'Foto do cliente nao encontrada.' });
      }

      const extension = path.extname(arquivo).toLowerCase();
      const mime = extension === '.png'
        ? 'image/png'
        : extension === '.webp'
          ? 'image/webp'
          : 'image/jpeg';

      res.type(mime);
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      const stream = fs.createReadStream(arquivo);
      stream.on('error', (streamErr) => {
        console.error('Erro ao enviar foto do cliente:', streamErr.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Erro ao exibir foto do cliente.' });
          return;
        }
        res.destroy(streamErr);
      });
      return stream.pipe(res);
    });
  });
});

/**
 * Adicionar ou trocar a foto de um cliente.
 */
router.post('/:id/foto', receberFoto, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de cliente invalido.' });
  }
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'Selecione uma foto.' });
  }

  const formato = detectarFormatoImagem(req.file.buffer);
  if (!formato || !mimeConfereComFormato(req.file.mimetype, formato)) {
    return res.status(415).json({ error: 'O arquivo nao e uma imagem JPG, PNG ou WebP valida.' });
  }

  try {
    const cliente = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM clientes WHERE id = ?', [id], (err, row) => err ? reject(err) : resolve(row));
    });
    if (!cliente) return res.status(404).json({ error: 'Cliente nao encontrado.' });
  } catch (err) {
    console.error('Erro ao validar cliente para foto:', err.message);
    return res.status(500).json({ error: 'Erro ao salvar foto do cliente.' });
  }

  const nomeArquivo = `cliente-${id}-${crypto.randomUUID()}.${formato.extension}`;
  const destino = resolverCaminhoFoto(nomeArquivo);
  if (!destino) return res.status(500).json({ error: 'Erro ao preparar foto do cliente.' });

  try {
    await fs.promises.writeFile(destino, req.file.buffer, { flag: 'wx' });
  } catch (writeErr) {
    console.error('Erro ao gravar foto do cliente:', writeErr.message);
    await removerArquivoFoto(nomeArquivo);
    return res.status(500).json({ error: 'Erro ao salvar foto do cliente.' });
  }

  let resultado;
  try {
    resultado = await atualizarFotoCliente({ dbPath: db.getDbPath(), clienteId: id, fotoCliente: nomeArquivo });
  } catch (err) {
    await removerArquivoFoto(nomeArquivo);
    console.error('Erro ao atualizar referencia da foto:', err.message);
    if (err.status === 404) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    return res.status(500).json({ error: 'Erro ao salvar foto do cliente.' });
  }

  if (resultado.clienteAntes.foto_cliente && resultado.clienteAntes.foto_cliente !== nomeArquivo) {
    await removerArquivoFoto(resultado.clienteAntes.foto_cliente);
  }
  try {
    await touchAtividade({ clienteId: id });
  } catch (touchErr) {
    console.error('[touchAtividade] cliente/foto:', touchErr);
  }
  return enviarClientePorId(id, res);
});

/**
 * Remover a foto atual de um cliente.
 */
router.delete('/:id/foto', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de cliente invalido.' });
  }

  let cliente;
  try {
    cliente = await new Promise((resolve, reject) => {
      db.get('SELECT id, foto_cliente FROM clientes WHERE id = ?', [id], (err, row) => err ? reject(err) : resolve(row));
    });
  } catch (err) {
    console.error('Erro ao buscar cliente para remover foto:', err.message);
    return res.status(500).json({ error: 'Erro ao remover foto do cliente.' });
  }
  if (!cliente) return res.status(404).json({ error: 'Cliente nao encontrado.' });
  if (!cliente.foto_cliente) return enviarClientePorId(id, res);

  let resultado;
  try {
    resultado = await atualizarFotoCliente({ dbPath: db.getDbPath(), clienteId: id, fotoCliente: null });
  } catch (err) {
    console.error('Erro ao limpar referencia da foto:', err.message);
    if (err.status === 404) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    return res.status(500).json({ error: 'Erro ao remover foto do cliente.' });
  }
  await removerArquivoFoto(resultado.clienteAntes.foto_cliente);
  try {
    await touchAtividade({ clienteId: id });
  } catch (touchErr) {
    console.error('[touchAtividade] cliente/remover-foto:', touchErr);
  }
  return enviarClientePorId(id, res);
});

/**
 * Listar telefones (principal + extras) de um cliente
 */
router.get('/:id/telefones', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de cliente invalido.' });
  }

  db.get('SELECT id, telefone FROM clientes WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('Erro ao buscar cliente para listar telefones:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar telefones.' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Cliente nao encontrado.' });
    }

    db.all(
      'SELECT id, telefone FROM clientes_telefones WHERE cliente_id = ? ORDER BY id ASC',
      [id],
      (errExtras, extrasRows) => {
        if (errExtras) {
          if (String(errExtras.message || '').toLowerCase().includes('no such table')) {
            const telefones = mergeTelefones(row.telefone, []);
            return res.json({ cliente_id: id, telefones_extras: [], telefones });
          }
          console.error('Erro ao buscar telefones extras:', errExtras.message);
          return res.status(500).json({ error: 'Erro ao buscar telefones.' });
        }

        const extras = (extrasRows || []).map((r) => String(r.telefone || '').trim());
        const telefones = mergeTelefones(row.telefone, extras);
        return res.json({ cliente_id: id, telefones_extras: extras, telefones });
      }
    );
  });
});

/**
 * Adicionar telefone extra para um cliente
 */
router.post('/:id/telefones', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de cliente invalido.' });
  }

  const telefoneFormatado = formatTelefoneBrasil(req.body && req.body.telefone);
  if (!telefoneFormatado) {
    return res.status(400).json({ error: 'Telefone invalido. Informe com DDD e numero.' });
  }

  let telefoneAdicionado;
  try {
    telefoneAdicionado = await adicionarTelefoneCliente({
      dbPath: db.getDbPath(), clienteId: id, telefone: telefoneFormatado,
      normalizarTelefone: normalizeTelefoneForCompare,
    });
  } catch (err) {
    console.error('Erro ao adicionar telefone extra:', err.message);
    if (err.status === 404) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    if (err.status === 409 || err.code === 'SQLITE_CONSTRAINT' || String(err.message || '').toLowerCase().includes('unique')) {
      return res.status(409).json({ error: 'Telefone ja cadastrado para este cliente.' });
    }
    return res.status(500).json({ error: 'Erro ao adicionar telefone.' });
  }
  try {
    await touchAtividade({ clienteId: id });
  } catch (touchErr) {
    console.error('[touchAtividade] cliente/add-telefone:', touchErr);
  }
  return res.status(201).json(telefoneAdicionado);
});

/**
 * Buscar cliente por ID
 * (rota param deve vir depois das rotas específicas)
 */
router.patch('/:id/mal-pagador', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de cliente invalido.' });
  }

  if (!hasOwn(req.body, 'mal_pagador')) {
    return res.status(400).json({ error: 'Campo mal_pagador obrigatorio.' });
  }

  const malPagador = parseMalPagador(req.body.mal_pagador);
  if (malPagador === null) {
    return res.status(400).json({ error: 'Valor de mal_pagador invalido.' });
  }

  try {
    await atualizarMalPagadorCliente({ dbPath: db.getDbPath(), clienteId: id, malPagador });
  } catch (err) {
    console.error('Erro ao atualizar marca de mal pagador:', err.message);
    if (err.status === 404) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    return res.status(500).json({ error: 'Erro ao atualizar cliente.' });
  }
  try {
    await touchAtividade({ clienteId: id });
  } catch (touchErr) {
    console.error('[touchAtividade] cliente/mal-pagador:', touchErr);
  }
  return enviarClientePorId(id, res);
});

router.patch('/:id/notificacoes-cobranca', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de cliente invalido.' });
  }
  if (!hasOwn(req.body, 'receber_notificacoes_cobranca')) {
    return res.status(400).json({ error: 'Campo receber_notificacoes_cobranca obrigatorio.' });
  }

  const receber = parseReceberNotificacoesCobranca(req.body.receber_notificacoes_cobranca);
  if (receber === null) {
    return res.status(400).json({ error: 'Valor de receber_notificacoes_cobranca invalido.' });
  }

  const temMotivo = hasOwn(req.body, 'motivo_notificacoes_cobranca');
  const motivoBruto = temMotivo ? req.body.motivo_notificacoes_cobranca : undefined;
  if (temMotivo && motivoBruto !== null && typeof motivoBruto !== 'string') {
    return res.status(400).json({ error: 'Motivo deve ser um texto ou nulo.' });
  }
  const motivo = temMotivo && typeof motivoBruto === 'string'
    ? motivoBruto.trim().slice(0, 2000) || null
    : motivoBruto;

  try {
    await atualizarPreferenciaCobrancaCliente({
      dbPath: db.getDbPath(), clienteId: id, receber, temMotivo, motivo,
    });
  } catch (err) {
    console.error('Erro ao atualizar notificacoes de cobranca:', err.message);
    if (err.status === 404) return res.status(404).json({ error: 'Cliente nao encontrado.' });
    return res.status(500).json({ error: 'Erro ao atualizar notificacoes de cobranca.' });
  }
  try {
    await touchAtividade({ clienteId: id });
    if (receber === 1) await gerarNotificacoesParaData();
  } catch (updateErr) {
    console.error('[cliente/notificacoes-cobranca] atualizacao complementar:', updateErr);
  }
  return enviarClientePorId(id, res);
});

router.get('/:id', (req, res) => {
  const id = req.params.id;
  return enviarClientePorId(id, res);
  db.get('SELECT * FROM clientes WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('Erro ao buscar cliente:', err.message);
      return res.status(500).json({ error: 'Erro ao buscar cliente.' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    anexarTelefonesExtras([row], (extraErr, clientesComTelefones) => {
      if (extraErr) {
        console.error('Erro ao buscar telefones extras do cliente:', extraErr.message);
        return res.status(500).json({ error: 'Erro ao buscar cliente.' });
      }
      res.json((clientesComTelefones && clientesComTelefones[0]) || row);
    });
  });
});

/**
 * Cadastrar novo cliente (id manual opcional)
 */
router.post('/', async (req, res) => {
  const {
    id,
    nome, cpf, telefone,
    endereco, trabalho, categoria_trabalho,
    referencia, observacao,
    criadoEm,
    mal_pagador
  } = req.body;

  // Validação: só campos obrigatórios nome, cpf, telefone e criadoEm
  if (!nome || !cpf || !telefone || !criadoEm) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const cpfClean = cleanCpf(cpf);
  const malPagadorInicial = hasOwn(req.body, 'mal_pagador')
    ? parseMalPagador(mal_pagador)
    : 0;
  if (malPagadorInicial === null) {
    return res.status(400).json({ error: 'Valor de mal_pagador invalido.' });
  }
  if (!cpfClean) {
    return res.status(400).json({ error: 'CPF inválido.' });
  }

  // Função para inserir cliente com id definido
  const inserir = async (novoId) => {
    const cols = [];
    const placeholders = [];
    const values = [];

    if (novoId) {
      cols.push('id');
      placeholders.push('?');
      values.push(novoId);
    }

    cols.push('nome','cpf','telefone','endereco','trabalho','categoria_trabalho','mal_pagador','referencia','observacao','criadoEm');
    placeholders.push('?','?','?','?','?','?','?','?','?','?');
    values.push(nome, cpfClean, telefone, endereco || '', trabalho || '', categoria_trabalho || '', malPagadorInicial, referencia || '', observacao || '', criadoEm);

    const sql = `INSERT INTO clientes (${cols.join(',')}) VALUES (${placeholders.join(',')})`;

    try {
      await ensureEntityIdentityV1(db);
      await ensureActionContractReady(db);
      await runAsync(db, 'BEGIN IMMEDIATE TRANSACTION');
    } catch (error) {
      console.error('Erro ao preparar acao de cliente:', error.message);
      return res.status(500).json({ error: 'Erro ao salvar cliente.' });
    }

    db.run(sql, values, async function(err) {
      if (err) {
        await runAsync(db, 'ROLLBACK').catch(() => {});
        console.error('Erro ao inserir cliente:', err.message);

        // lidar com constraint UNIQUE no CPF (e também ID)
        if (err.code === 'SQLITE_CONSTRAINT' || err.message.includes('UNIQUE')) {
          // tentar identificar se é CPF duplicado ou ID duplicado
          if (err.message.includes('clientes.cpf') || err.message.toLowerCase().includes('cpf')) {
            return res.status(409).json({ error: 'CPF já cadastrado.' });
          }
          if (novoId && (err.message.includes('clientes.id') || err.message.toLowerCase().includes('id'))) {
            return res.status(409).json({ error: `ID ${novoId} já existe.` });
          }
          // fallback
          return res.status(409).json({ error: 'Registro duplicado (constraint).' });
        }

        return res.status(500).json({ error: 'Erro ao salvar cliente.' });
      }

      const clienteId = novoId || this.lastID;
      try {
        const depois = await capturarEstadoCliente(clienteId, { dbHandle: db });
        await registrarAcaoCliente({
          tipo: ACTION_TYPES.CLIENTE_CRIADO,
          clienteId,
          antes: { cliente: null, telefones: [] },
          depois,
          resumo: `Cliente ${clienteId} criado`,
        }, { dbHandle: db });
      } catch (actionError) {
        await runAsync(db, 'ROLLBACK').catch(() => {});
        console.error('Erro ao registrar acao de cliente criado:', actionError.message);
        return res.status(500).json({ error: 'Erro ao salvar cliente.' });
      }
      try {
        await touchAtividade({ clienteId });
      } catch (touchErr) {
        console.error('[touchAtividade] cliente/create:', touchErr);
      }

      try {
        await runAsync(db, 'COMMIT');
      } catch (commitError) {
        await runAsync(db, 'ROLLBACK').catch(() => {});
        console.error('Erro ao confirmar cliente criado:', commitError.message);
        return res.status(500).json({ error: 'Erro ao salvar cliente.' });
      }
      return enviarClientePorId(clienteId, res, 201);
    });
  };

  // Se o ID foi informado no corpo da requisição, tenta usar ele
  if (id) {
    // Verifica se o ID já existe para evitar conflito
    db.get('SELECT id FROM clientes WHERE id = ?', [id], (err, row) => {
      if (err) {
        console.error('Erro ao verificar ID:', err.message);
        return res.status(500).json({ error: 'Erro ao salvar cliente.' });
      }
      if (row) {
        return res.status(409).json({ error: `ID ${id} já existe.` });
      }

      // Também checar CPF existente (entre IDs)
      db.get(
        `SELECT id FROM clientes WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? LIMIT 1`,
        [cpfClean],
        (err2, row2) => {
          if (err2) {
            console.error('Erro ao verificar CPF:', err2.message);
            return res.status(500).json({ error: 'Erro ao salvar cliente.' });
          }
          if (row2) {
            return res.status(409).json({ error: 'CPF já cadastrado.' });
          }
          inserir(id);
        }
      );
    });
  } else {
    // Se ID não foi informado, buscar todos os IDs existentes ordenados
    // Antes de inserir, checar CPF duplicado
    db.get(
      `SELECT id FROM clientes WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? LIMIT 1`,
      [cpfClean],
      (errCpf, rowCpf) => {
        if (errCpf) {
          console.error('Erro ao checar CPF antes de inserir:', errCpf.message);
          return res.status(500).json({ error: 'Erro ao salvar cliente.' });
        }
        if (rowCpf) {
          return res.status(409).json({ error: 'CPF já cadastrado.' });
        }

        db.all('SELECT id FROM clientes ORDER BY id ASC', (err, rows) => {
          if (err) {
            console.error('Erro ao buscar IDs:', err.message);
            return res.status(500).json({ error: 'Erro ao salvar cliente.' });
          }

          // Se não tem clientes, id começa em 1
          if (!rows || rows.length === 0) {
            return inserir(1);
          }

          // Agora procura o menor ID livre (buraco)
          let nextId = 1;
          for (let i = 0; i < rows.length; i++) {
            const currentId = rows[i].id;
            if (currentId !== nextId) {
              // achou o buraco
              break;
            }
            nextId++;
          }
          inserir(nextId);
        });
      }
    );
  }
});

/**
 * Editar cliente existente
 */
router.put('/:id', exigirProtecao('editar_cliente'), (req, res) => {
  const id = clienteIdValido(req.params.id);
  const novoId = hasOwn(req.body, 'id') ? clienteIdValido(req.body.id) : id;
  if (!id || !novoId) {
    return res.status(400).json({ error: 'ID deve ser um número inteiro positivo válido.' });
  }
  const {
    nome, cpf, telefone,
    endereco, trabalho, categoria_trabalho,
    referencia, observacao,
    criadoEm,
    mal_pagador,
    receber_notificacoes_cobranca,
    motivo_notificacoes_cobranca
  } = req.body;

  // Validação campos obrigatórios só esses 4
  if (!nome || !cpf || !telefone || !criadoEm) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const cpfClean = cleanCpf(cpf);
  const temMalPagadorNoPayload = hasOwn(req.body, 'mal_pagador');
  const malPagadorAtualizado = temMalPagadorNoPayload
    ? parseMalPagador(mal_pagador)
    : null;
  if (temMalPagadorNoPayload && malPagadorAtualizado === null) {
    return res.status(400).json({ error: 'Valor de mal_pagador invalido.' });
  }
  const temReceberNotificacoesNoPayload = hasOwn(req.body, 'receber_notificacoes_cobranca');
  const receberNotificacoesAtualizado = temReceberNotificacoesNoPayload
    ? parseReceberNotificacoesCobranca(receber_notificacoes_cobranca)
    : null;
  if (temReceberNotificacoesNoPayload && receberNotificacoesAtualizado === null) {
    return res.status(400).json({ error: 'Valor de receber_notificacoes_cobranca invalido.' });
  }
  const temMotivoNotificacoesNoPayload = hasOwn(req.body, 'motivo_notificacoes_cobranca');
  if (
    temMotivoNotificacoesNoPayload &&
    motivo_notificacoes_cobranca !== null &&
    typeof motivo_notificacoes_cobranca !== 'string'
  ) {
    return res.status(400).json({ error: 'Motivo deve ser um texto ou nulo.' });
  }
  const motivoNotificacoesAtualizado = temMotivoNotificacoesNoPayload
    ? (typeof motivo_notificacoes_cobranca === 'string'
      ? motivo_notificacoes_cobranca.trim().slice(0, 2000) || null
      : motivo_notificacoes_cobranca)
    : null;
  if (!cpfClean) {
    return res.status(400).json({ error: 'CPF inválido.' });
  }

  // Verifica se cpf já pertence a outro cliente
  db.get(
    `SELECT id FROM clientes WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = ? AND id != ? LIMIT 1`,
    [cpfClean, id],
    async (errCheck, rowCheck) => {
      if (errCheck) {
        console.error('Erro ao checar CPF para edição:', errCheck.message);
        return res.status(500).json({ error: 'Erro ao editar cliente.' });
      }
      if (rowCheck) {
        return res.status(409).json({ error: 'CPF já cadastrado para outro cliente.' });
      }

      const sql = `UPDATE clientes
                   SET id = ?, nome = ?, cpf = ?, telefone = ?, endereco = ?, trabalho = ?, categoria_trabalho = ?,
                       referencia = ?, observacao = ?, criadoEm = ?, mal_pagador = COALESCE(?, mal_pagador),
                       receber_notificacoes_cobranca = COALESCE(?, receber_notificacoes_cobranca),
                       motivo_notificacoes_cobranca = CASE WHEN ? THEN ? ELSE motivo_notificacoes_cobranca END
                    WHERE id = ?`;

      try {
        await salvarEdicaoCliente({
          dbPath: db.getDbPath(), idAtual: id, novoId, cpf: cpfClean, sql,
          valores: [novoId, nome, cpfClean, telefone, endereco || '', trabalho || '', categoria_trabalho || '', referencia || '', observacao || '', criadoEm, malPagadorAtualizado, receberNotificacoesAtualizado, temMotivoNotificacoesNoPayload ? 1 : 0, motivoNotificacoesAtualizado, id],
          registrarAcao: ({ dbHandle, antes, depois }) => registrarAcaoCliente({
            tipo: ACTION_TYPES.CLIENTE_EDITADO,
            clienteId: novoId,
            antes,
            depois,
            resumo: `Cliente ${id} editado`,
            metadata: { cliente_id_anterior: id, cliente_id_posterior: novoId },
          }, { dbHandle }),
        });
      } catch (err) {
        console.error('Erro ao atualizar cliente:', err.message);
        if (err.status) return res.status(err.status).json({ error: err.message });
        return res.status(500).json({ error: 'Erro ao editar cliente.' });
      }
      try {
        await touchAtividade({ clienteId: novoId });
        if (receberNotificacoesAtualizado === 1) await gerarNotificacoesParaData();
      } catch (touchErr) {
        console.error('[touchAtividade] cliente/update:', touchErr);
      }
      return enviarClientePorId(novoId, res);
    }
  );
});

/**
 * Excluir cliente
 */
router.delete('/:id', exigirProtecao('excluir_cliente'), (req, res) => {
  const id = req.params.id;

  db.get('SELECT id, foto_cliente FROM clientes WHERE id = ?', [id], async (findErr, cliente) => {
    if (findErr) {
      console.error('Erro ao buscar cliente para excluir:', findErr.message);
      return res.status(500).json({ error: 'Erro ao excluir cliente.' });
    }
    if (!cliente) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    let antes;
    try {
      await ensureEntityIdentityV1(db);
      await ensureActionContractReady(db);
      await runAsync(db, 'BEGIN IMMEDIATE TRANSACTION');
      antes = await capturarEstadoCliente(id, { dbHandle: db });
      if (!antes.cliente) {
        await runAsync(db, 'ROLLBACK').catch(() => {});
        return res.status(404).json({ error: 'Cliente nao encontrado.' });
      }
      await registrarAcaoCliente({
        tipo: ACTION_TYPES.CLIENTE_EXCLUIDO,
        clienteId: Number(id),
        antes,
        depois: { cliente: null, telefones: [] },
        resumo: `Cliente ${id} excluido`,
      }, { dbHandle: db });
    } catch (actionError) {
      await runAsync(db, 'ROLLBACK').catch(() => {});
      console.error('Erro ao preparar acao de cliente excluido:', actionError.message);
      return res.status(500).json({ error: 'Erro ao excluir cliente.' });
    }

    return db.run('DELETE FROM clientes WHERE id = ?', [id], async function (err) {
      if (err) {
        await runAsync(db, 'ROLLBACK').catch(() => {});
        console.error('Erro ao excluir cliente:', err.message);
        return res.status(500).json({ error: 'Erro ao excluir cliente.' });
      }
      if (this.changes === 0) {
        await runAsync(db, 'ROLLBACK').catch(() => {});
        return res.status(404).json({ error: 'Cliente não encontrado.' });
      }

      try {
        await runAsync(db, 'COMMIT');
      } catch (commitError) {
        await runAsync(db, 'ROLLBACK').catch(() => {});
        console.error('Erro ao confirmar cliente excluido:', commitError.message);
        return res.status(500).json({ error: 'Erro ao excluir cliente.' });
      }
      await removerArquivoFoto(cliente.foto_cliente);
      return res.json({ message: 'Cliente excluído com sucesso.' });
    });
  });
});

module.exports = router;
