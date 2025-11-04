// backend/controllers/emprestimocontroller.js
const emprestimoService = require('../services/servicoemprestimo');
const gerarParcelas = require('../utils/gerarParcelas'); // para endpoint de preview (opcional)

/**
 * Helpers locais de parsing
 */
function toNumberSafe(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  const s = String(v).trim();
  if (s === '') return null;
  // aceita "1.234,56" ou "1234,56" ou "1234.56"
  let t = s;
  if (t.indexOf(',') > -1 && t.indexOf('.') > -1) {
    t = t.replace(/\./g, '').replace(',', '.');
  } else if (t.indexOf(',') > -1 && t.indexOf('.') === -1) {
    t = t.replace(',', '.');
  } else {
    // nada
  }
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

function toIntegerSafe(v) {
  const n = toNumberSafe(v);
  if (n === null) return null;
  const i = Math.trunc(n);
  return Number.isFinite(i) ? i : null;
}

function isValidDateString(s) {
  if (!s) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

/**
 * listarTodos
 */
exports.listarTodos = async (req, res) => {
  try {
    const emprestimos = await emprestimoService.listarTodosEmprestimos();
    res.json(emprestimos);
  } catch (error) {
    console.error('listarTodos erro:', error);
    res.status(500).json({ error: error.message || 'Erro ao buscar empréstimos.' });
  }
};

/**
 * buscarPorId
 */
exports.buscarPorId = async (req, res) => {
  try {
    const emprestimo = await emprestimoService.buscarEmprestimoPorId(req.params.id);
    if (!emprestimo) return res.status(404).json({ error: 'Empréstimo não encontrado.' });
    res.json(emprestimo);
  } catch (error) {
    console.error('buscarPorId erro:', error);
    res.status(500).json({ error: error.message || 'Erro ao buscar empréstimo.' });
  }
};

/**
 * atualizar
 */
exports.atualizar = async (req, res) => {
  try {
    const resultado = await emprestimoService.atualizarEmprestimo(req.params.id, req.body);
    res.json(resultado);
  } catch (error) {
    console.error('atualizar erro:', error);
    if (error.message === 'Campos obrigatórios ausentes.') return res.status(400).json({ error: error.message });
    res.status(500).json({ error: 'Erro ao atualizar empréstimo.' });
  }
};

/**
 * criar
 * Aceita:
 *  - cliente_id (number)
 *  - valor (number)
 *  - data (string ISO) -> data de início do empréstimo
 *  - modalidade (string)
 *  - parcelas (number) - quando modalidade === 'parcelado'
 *  - taxa_juros (number)
 *  - observacao (string)
 *  - dia_pagamento (number 1..31) OR data_pagamento (string ISO completa)
 *
 * O controller converte e envia para o service com dia_pagamento numérico.
 */
exports.criar = async (req, res) => {
  try {
    // extrai campos esperados
    const {
      cliente_id: rawClienteId,
      valor: rawValor,
      data: rawData,
      modalidade,
      parcelas: rawParcelas,
      taxa_juros: rawTaxa,
      observacao,
      dia_pagamento: rawDiaPagamento,
      data_pagamento: rawDataPagamento,
      // mantém quaisquer outros campos no resto (para compatibilidade)
    } = req.body;

    console.log('Criando empréstimo - payload recebido:', req.body);

    // validações básicas e parsing
    const cliente_id = toIntegerSafe(rawClienteId);
    const valor = toNumberSafe(rawValor);
    const taxa_juros = toNumberSafe(rawTaxa);
    const parcelas = rawParcelas == null ? null : toIntegerSafe(rawParcelas);
    const data = (typeof rawData === 'string') ? rawData : (rawData instanceof Date ? rawData.toISOString().split('T')[0] : null);

    if (!cliente_id) return res.status(400).json({ error: 'cliente_id inválido ou ausente.' });
    if (valor == null || valor <= 0) return res.status(400).json({ error: 'valor inválido ou ausente.' });
    if (!data || !isValidDateString(data)) return res.status(400).json({ error: 'data (data de início) inválida ou ausente. Use ISO YYYY-MM-DD.' });
    if (!modalidade) return res.status(400).json({ error: 'modalidade ausente.' });
    if (taxa_juros == null) return res.status(400).json({ error: 'taxa_juros ausente.' });

    if (modalidade === 'parcelado' && (parcelas == null || parcelas <= 0)) {
      return res.status(400).json({ error: 'parcelas ausente ou inválida para modalidade parcelado.' });
    }

    // >>> calcular dia_pagamento numérico (1..31)
    // prioridade: data_pagamento (data completa) -> dia desta data
    // fallback: dia_pagamento numérico enviado
    // fallback final: usar dia da própria `data` (data de início)
    // se tudo inválido, usar 15
    let diaToSave = null;

    if (rawDataPagamento && typeof rawDataPagamento === 'string' && isValidDateString(rawDataPagamento)) {
      diaToSave = new Date(rawDataPagamento).getDate();
    } else if (rawDiaPagamento != null && rawDiaPagamento !== '') {
      const parsed = toIntegerSafe(rawDiaPagamento);
      if (parsed != null) {
        diaToSave = Math.min(31, Math.max(1, parsed));
      }
    }

    if (diaToSave == null) {
      // usar dia da data de início (se válido)
      const dt = new Date(data);
      if (!Number.isNaN(dt.getTime())) {
        diaToSave = dt.getDate();
      } else {
        diaToSave = 15;
      }
    }

    // monta objeto para o service (compatível com servicoemprestimo.criarEmprestimo)
    const dadosParaCriar = {
      cliente_id,
      valor,
      data, // string ISO
      modalidade,
      parcelas: parcelas,
      taxa_juros,
      observacao: observacao || '',
      dia_pagamento: Number(diaToSave)
    };

    console.log('Chamando servico.criarEmprestimo com:', dadosParaCriar);

    const resultado = await emprestimoService.criarEmprestimo(dadosParaCriar);

    console.log('Empréstimo criado:', resultado);
    res.json(resultado);
  } catch (error) {
    console.error('criar erro:', error);
    if (error.message === 'Campos obrigatórios ausentes.') return res.status(400).json({ error: error.message });
    res.status(500).json({ error: error.message || 'Erro ao criar empréstimo.' });
  }
};

/**
 * atualizarParcelaVencimento
 */
exports.atualizarParcelaVencimento = async (req, res) => {
  try {
    console.log('Recebendo requisição para atualizar vencimento - id:', req.params.id, 'body:', req.body);
    const resultado = await emprestimoService.atualizarParcelaVencimento(
      req.params.id,
      req.body.vencimento
    );
    console.log('Resultado atualizarParcelaVencimento:', resultado);
    res.json(resultado);
  } catch (error) {
    console.error('atualizarParcelaVencimento erro:', error);
    res.status(500).json({ error: error.message || 'Erro ao atualizar parcela.' });
  }
};

/**
 * previewParcelas (opcional)
 * Recebe JSON com: valor, taxa_juros, parcelas (qtd), data (dataInicio ISO), data_pagamento OR dia_pagamento
 * Retorna array de parcelas geradas (mesma função usada pelo backend ao criar).
 */
exports.previewParcelas = (req, res) => {
  try {
    const { valor: rawValor, taxa_juros: rawTaxa, parcelas: rawParcelas, data: rawData, data_pagamento: rawDataPagamento, dia_pagamento: rawDiaPagamento } = req.body;

    const valor = toNumberSafe(rawValor);
    const taxa_juros = toNumberSafe(rawTaxa);
    const qtdParcelas = toIntegerSafe(rawParcelas);
    const dataInicio = rawData && isValidDateString(rawData) ? rawData : (new Date()).toISOString().split('T')[0];

    if (valor == null || taxa_juros == null || qtdParcelas == null) {
      return res.status(400).json({ error: 'Parâmetros inválidos. Forneça valor, taxa_juros e parcelas.' });
    }

    // resolve diaPagamento: se data_pagamento (string válida) -> usa ela; senão se dia_pagamento numérico -> usa ele; senão undefined
    let diaPagamento = undefined;
    if (rawDataPagamento && typeof rawDataPagamento === 'string' && isValidDateString(rawDataPagamento)) {
      diaPagamento = rawDataPagamento;
    } else if (rawDiaPagamento != null && rawDiaPagamento !== '') {
      const parsed = toIntegerSafe(rawDiaPagamento);
      if (parsed != null) diaPagamento = parsed;
    }

    // chamar util gerarParcelas
    const geradas = gerarParcelas({
      capital: Number(valor),
      taxa_juros: Number(taxa_juros),
      qtdParcelas: Number(qtdParcelas),
      dataInicio: dataInicio,
      diaPagamento: diaPagamento
    });

    return res.json({ parcelas: geradas });
  } catch (error) {
    console.error('previewParcelas erro:', error);
    res.status(500).json({ error: 'Erro ao gerar preview de parcelas.' });
  }
};