function sanitizeText(value, fallback = '') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function toMoney(value) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(safe);
}

function toValidDateParts(dayRaw, monthRaw, yearRaw) {
  const day = Number(dayRaw);
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;
  if (year < 1900 || year > 2300) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const dt = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() !== year) return null;
  if (dt.getUTCMonth() + 1 !== month) return null;
  if (dt.getUTCDate() !== day) return null;

  return { day, month, year };
}

const MONTHS_PT = [
  'janeiro',
  'fevereiro',
  'marco',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

function humanDate(value) {
  const text = sanitizeText(value);
  if (!text) return '-';

  const iso = text.slice(0, 10);
  const isoParts = iso.split('-');
  if (isoParts.length === 3) {
    const parsed = toValidDateParts(isoParts[2], isoParts[1], isoParts[0]);
    if (parsed) {
      const monthName = MONTHS_PT[parsed.month - 1] || String(parsed.month).padStart(2, '0');
      return `${String(parsed.day).padStart(2, '0')} de ${monthName} de ${parsed.year}`;
    }
  }

  const br = text.slice(0, 10);
  const brParts = br.split('/');
  if (brParts.length === 3) {
    const parsed = toValidDateParts(brParts[0], brParts[1], brParts[2]);
    if (parsed) {
      const monthName = MONTHS_PT[parsed.month - 1] || String(parsed.month).padStart(2, '0');
      return `${String(parsed.day).padStart(2, '0')} de ${monthName} de ${parsed.year}`;
    }
  }

  return text;
}

function buildDomainAnswer({ toolName, toolArgs, toolResult, intent }) {
  const name = sanitizeText(toolName).toLowerCase();
  const args = toolArgs && typeof toolArgs === 'object' ? toolArgs : {};
  const result = toolResult && typeof toolResult === 'object' ? toolResult : {};

  if (name === 'caixa_resumo') {
    const de = humanDate(result.de || args.de);
    const ate = humanDate(result.ate || args.ate);
    const totalRecebido = toMoney(result.total_recebido);
    const totalCapital = toMoney(result.total_capital_recebido);
    const totalJuros = toMoney(result.total_juros_recebido);
    const saldo = toMoney(result.saldo);

    if (String(de) === String(ate)) {
      return `No dia ${de}, entrou ${totalRecebido} (capital ${totalCapital} e juros ${totalJuros}). Saldo do periodo: ${saldo}.`;
    }
    return `No periodo de ${de} ate ${ate}, entrou ${totalRecebido} (capital ${totalCapital} e juros ${totalJuros}). Saldo do periodo: ${saldo}.`;
  }

  if (name === 'parcelas_por_periodo') {
    const total = Number(result.total || 0);
    const de = humanDate(result.de || args.de);
    const ate = humanDate(result.ate || args.ate);
    const tipo = sanitizeText(result.tipo || args.tipo, 'todas');
    const normalizedIntent = sanitizeText(intent).toLowerCase();
    const isForecast = normalizedIntent.includes('previsao_recebimento');

    if (total <= 0) {
      if (isForecast) {
        return `No periodo de ${de} ate ${ate}, previsao de recebimento: ${toMoney(0)}. Parcelas previstas: 0. Clientes unicos: 0.`;
      }
      return `Nao encontrei parcelas (${tipo}) entre ${de} e ${ate}.`;
    }

    const parcelas = Array.isArray(result.parcelas) ? result.parcelas : [];
    if (isForecast) {
      let somaValorTotal = 0;
      const uniqueClients = new Set();
      for (const p of parcelas) {
        const valorTotal = Number(p && p.valor_total);
        if (Number.isFinite(valorTotal)) somaValorTotal += valorTotal;
        const clienteId = Number(p && p.cliente_id ? p.cliente_id : 0);
        const clienteNome = sanitizeText(p && p.cliente_nome, 'cliente_sem_nome').toLowerCase();
        const key = clienteId > 0 ? `id:${clienteId}` : `nome:${clienteNome}`;
        uniqueClients.add(key);
      }
      return `No periodo de ${de} ate ${ate}, previsao de recebimento: ${toMoney(somaValorTotal)}. Parcelas previstas: ${total}. Clientes unicos: ${uniqueClients.size}.`;
    }

    const preview = parcelas
      .slice(0, 3)
      .map((p) => {
        const cliente = sanitizeText(p && p.cliente_nome, 'Cliente');
        const numero = p && p.numero != null ? Number(p.numero) : null;
        const vencimento = humanDate(p && p.vencimento);
        const valor = toMoney(p && (p.total_devido_calculado != null ? p.total_devido_calculado : p.valor_total));
        return `${cliente} (parcela ${numero != null ? numero : '-'}, vence ${vencimento}, ${valor})`;
      })
      .join('; ');

    return `Encontrei ${total} parcela(s) (${tipo}) entre ${de} e ${ate}.${preview ? ` Exemplos: ${preview}.` : ''}`;
  }

  if (name === 'emprestimo_detalhe') {
    const id = result.id != null ? Number(result.id) : null;
    const cliente = sanitizeText(result.cliente_nome, 'cliente nao identificado');
    const abertas = Number(result.parcelas_em_aberto || 0);
    const capitalRestante = toMoney(result.capital_restante);
    const totalPago = toMoney(result.total_pago);
    return `Emprestimo #${id != null ? id : '-'} (${cliente}): ${abertas} parcela(s) em aberto, capital restante ${capitalRestante} e total pago ${totalPago}.`;
  }

  if (name === 'notificacoes_pendentes') {
    const total = Number(result.total || 0);
    if (total <= 0) return 'Nao ha notificacoes pendentes no momento.';

    const itens = Array.isArray(result.notificacoes) ? result.notificacoes : [];
    const preview = itens
      .slice(0, 3)
      .map((n) => {
        const cliente = sanitizeText(n && n.cliente_nome, 'Cliente');
        const tipo = sanitizeText(n && n.tipo, 'alerta');
        const vencimento = humanDate(n && n.parcela_vencimento);
        return `${cliente} (${tipo}${vencimento !== '-' ? `, vencimento ${vencimento}` : ''})`;
      })
      .join('; ');

    return `Existem ${total} notificacao(oes) pendentes.${preview ? ` Exemplos: ${preview}.` : ''}`;
  }

  if (name === 'cliente_busca') {
    const total = Number(result.total || 0);
    const clientes = Array.isArray(result.clientes) ? result.clientes : [];
    if (total <= 0) return 'Nao encontrei cliente com os criterios informados.';
    if (total === 1 && clientes.length) {
      const c = clientes[0] || {};
      return `Encontrei 1 cliente: #${c.id || '-'} ${sanitizeText(c.nome, 'Sem nome')}.`;
    }
    const nomes = clientes
      .slice(0, 5)
      .map((c) => `#${c && c.id != null ? c.id : '-'} ${sanitizeText(c && c.nome, 'Sem nome')}`)
      .join('; ');
    return `Encontrei ${total} clientes. Primeiros resultados: ${nomes}.`;
  }

  if (name === 'runtime_sql_readonly' || name === 'query_financial_data') {
    const returned = Number(result.returned_rows || 0);
    return `Consulta financeira concluida. Linhas retornadas: ${returned}${result.truncated ? ' (resultado limitado)' : ''}.`;
  }

  return `Consulta concluida com sucesso${intent ? ` (${intent})` : ''}.`;
}

function buildCodeEvidenceAnswer(repoEvidence = []) {
  const evidence = Array.isArray(repoEvidence) ? repoEvidence : [];
  if (!evidence.length) {
    return 'Nao encontrei evidencias de codigo suficientes com os limites de leitura atuais.';
  }

  const lines = ['Evidencias no codigo:'];
  const maxItems = Math.min(3, evidence.length);
  for (let i = 0; i < maxItems; i += 1) {
    const item = evidence[i] || {};
    const path = sanitizeText(item.path, 'arquivo_desconhecido');
    const line = Number(item.start_line);
    const snippet = sanitizeText(item.snippet).replace(/\s+/g, ' ').slice(0, 160);
    lines.push(`${i + 1}) ${path}${Number.isFinite(line) ? `:${line}` : ''} - ${snippet}`);
  }

  return lines.join('\n');
}

function buildLogAnswer(logPayload) {
  const payload = logPayload && typeof logPayload === 'object' ? logPayload : {};
  if (!payload.exists) {
    return `Nao encontrei o arquivo de log ${sanitizeText(payload.file, 'backend.log')}.`;
  }

  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (!lines.length) {
    return `O arquivo ${sanitizeText(payload.file, 'backend.log')} existe, mas nao ha linhas para mostrar.`;
  }

  const preview = lines.slice(Math.max(0, lines.length - 5)).join('\n');
  return `Ultimas linhas de ${sanitizeText(payload.file, 'backend.log')}:\n${preview}`;
}

function buildSourceFootnote(sources = []) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length) {
    return 'Fontes: inferencia controlada (sem evidencia suficiente).';
  }

  const compact = [];
  for (const src of list.slice(0, 6)) {
    const type = sanitizeText(src.source_type, 'unknown');
    const label = sanitizeText(src.label || src.reference || src.tool || src.path, 'fonte_sem_rotulo');
    compact.push(`[${type}] ${label}`);
  }

  return `Fontes: ${compact.join(' | ')}`;
}

function composeFinalAnswer({
  route,
  domainSummary,
  codeSummary,
  logSummary,
  verification,
  notes = [],
}) {
  const parts = [];

  if (domainSummary) parts.push(domainSummary);
  if (codeSummary) parts.push(codeSummary);
  if (logSummary) parts.push(logSummary);

  if (!parts.length) {
    parts.push('Nao consegui montar uma resposta validada com as fontes disponiveis.');
  }

  const safeVerification = verification && typeof verification === 'object' ? verification : {};
  if (safeVerification.validated === false) {
    parts.push('Validacao: parcial ou inconclusiva.');
  }
  if (Array.isArray(safeVerification.conflicts) && safeVerification.conflicts.length) {
    parts.push('Conflitos detectados entre fontes.');
  }
  if (Array.isArray(notes) && notes.length) {
    parts.push(...notes.filter(Boolean));
  }

  if (route && route.category === 'action_modification') {
    parts.push('Modo acao: neste assistente interno eu apenas proponho plano e patch; nao executo escrita automaticamente.');
  }

  return parts.join('\n\n');
}

module.exports = {
  buildDomainAnswer,
  buildCodeEvidenceAnswer,
  buildLogAnswer,
  buildSourceFootnote,
  composeFinalAnswer,
};
