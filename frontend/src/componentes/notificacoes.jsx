// frontend/src/componentes/notificacoes.jsx
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { useLocation } from 'react-router-dom';
import notify from '../ui/notify';
import {
  formatarData,
  renderLinhaJuros,
  getTotalDevidoParcela,
} from './Emprestimos/helpers.jsx';
import Auditoria from './auditoria';
import { isClienteMalPagador } from '../utils/clientRisk';
import ClienteIdentity from './common/ClienteIdentity.jsx';
import useClientesCatalogo from './common/useClientesCatalogo.js';

const TIPO_LABELS = {
  parcela_muito_atrasada: 'Muito atrasadas',
  parcela_atrasada: 'Parcelas atrasadas',
  parcela_vence_hoje: 'Vencem hoje',
  parcela_vence_em_breve: 'Vencem em breve',
  recalculado_em_aberto: 'Recalculados em aberto',
};

const TIPO_ORDEM = [
  'parcela_muito_atrasada',
  'parcela_atrasada',
  'parcela_vence_hoje',
  'parcela_vence_em_breve',
  'recalculado_em_aberto',
];
const TIPOS_ATRASO_SET = new Set(['parcela_muito_atrasada', 'parcela_atrasada']);

const CONFIG_DEFAULT = {
  venceEmBreveDias: 3,
};

const RETORNO_NOTIFICACOES_KEY = 'notificacoes.retornoContexto';
const NOTIFICACOES_LAYOUT_KEY = 'notificacoes.layoutMode';
const ORDENACAO_NOTIFICACOES_KEY = 'notificacoes.ordenacao';
const ORDENACOES_NOTIFICACOES_VALIDAS = new Set([
  'idCrescente',
  'idDecrescente',
  'nomeAZ',
  'nomeZA',
  'maisAntigos',
  'maisNovos',
  'maiorValor',
  'menorValor',
  'ultimoTrabalhado',
  'malPagadores',
  'notificacoesDesligadas',
]);

const temNotificacoesDesligadas = (cliente) =>
  Number(cliente?.cliente_receber_notificacoes_cobranca ?? 1) !== 1;

const parseError = (err, fallback) =>
  err?.response?.data?.error ||
  err?.response?.data?.erro ||
  err?.message ||
  fallback ||
  'Erro inesperado.';

const normalizarTextoBusca = (valor) =>
  String(valor || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

const filtrarClientesPorBusca = (clientes, buscaRaw, buscaIdRaw = '') => {
  const termoId = String(buscaIdRaw || '').trim();
  const clientesPorId = termoId
    ? clientes.filter((cliente) => String(cliente?.cliente_id ?? '').startsWith(termoId))
    : clientes;
  const termoRaw = String(buscaRaw || '').trim();
  if (!termoRaw) return clientesPorId;

  const termoNormalizado = normalizarTextoBusca(termoRaw);
  return clientesPorId.filter((cliente) => {
    const nomeNormalizado = normalizarTextoBusca(cliente?.cliente_nome || '');
    return nomeNormalizado.startsWith(termoNormalizado);
  });
};

const formatarMoeda = (valor) => {
  const n = Number(valor || 0);
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      minimumFractionDigits: 2,
    }).format(n);
  } catch {
    return `R$ ${n.toFixed(2)}`;
  }
};

const hojeLocalISO = () => {
  const d = new Date();
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
};

const diffDias = (vencISO, refISO) => {
  if (!vencISO || !refISO) return null;
  const d1 = new Date(`${vencISO}T00:00:00`);
  const d2 = new Date(`${refISO}T00:00:00`);
  const ms = d1.getTime() - d2.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
};

const statusTempo = (vencISO, refISO) => {
  const diff = diffDias(vencISO, refISO);
  if (diff === null || diff === undefined) return null;
  if (diff === 0) return 'Vence hoje';
  if (diff > 0) return `Vence em ${diff} dia(s)`;
  return `Atrasada há ${Math.abs(diff)} dia(s)`;
};

const getClienteGroupKey = (n) => {
  const cpf = String(n?.cliente_cpf || '').trim();
  if (cpf) return `cpf:${cpf}`;

  const id = n?.cliente_id;
  if (id !== null && id !== undefined && String(id).trim() !== '') {
    return `id:${String(id).trim()}`;
  }

  const nome = String(n?.cliente_nome || '').trim().toLowerCase();
  const emprestimo = String(n?.emprestimo_id || '').trim();
  return `fallback:${nome}|${emprestimo}`;
};

const getParcelaGroupKey = (n) => {
  if (n?.parcela_id !== null && n?.parcela_id !== undefined && n?.parcela_id !== '') {
    return `parcela:${n.parcela_id}`;
  }

  const emprestimo = n?.emprestimo_id ?? 'sem_emprestimo';
  const numero = n?.parcela_numero ?? 'sem_numero';
  const venc = n?.parcela_vencimento ?? 'sem_vencimento';
  return `${emprestimo}-${numero}-${venc}`;
};

const getVencimentoTs = (vencISO) => {
  if (!vencISO) return Number.POSITIVE_INFINITY;
  const t = Date.parse(`${vencISO}T00:00:00`);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

const toNumSeguro = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value === null || value === undefined) return 0;

  const raw = String(value).trim();
  if (!raw) return 0;

  const sanitized = raw
    .replace(/\s+/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '');
  const parsed = Number(sanitized);
  if (Number.isFinite(parsed)) return parsed;

  const fallback = Number(raw.replace(',', '.'));
  return Number.isFinite(fallback) ? fallback : 0;
};

const getValorDevidoNotificacao = (n) => {
  const valorTotal = toNumSeguro(n?.parcela_valor_total);
  const jurosAdicionais = toNumSeguro(n?.parcela_juros_adicionais);

  let totalDevidoBruto = 0;
  if (valorTotal > 0 || jurosAdicionais > 0) {
    totalDevidoBruto = valorTotal + jurosAdicionais;
  } else {
    totalDevidoBruto =
      toNumSeguro(n?.parcela_valor_capital) +
      toNumSeguro(n?.parcela_valor_juros) +
      toNumSeguro(n?.parcela_juros_pendentes) +
      jurosAdicionais;
  }

  const pago = toNumSeguro(n?.parcela_valor_pago);
  return Math.max(0, totalDevidoBruto - pago);
};

const parseTs = (value) => {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const raw = String(value).trim();
  if (!raw) return 0;
  const normalized =
    raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw;
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : 0;
};

const TIPO_BADGE_CLASS = {
  parcela_muito_atrasada: 'is-severe',
  parcela_atrasada: 'is-danger',
  parcela_vence_hoje: 'is-warning',
  parcela_vence_em_breve: 'is-info',
  recalculado_em_aberto: 'is-neutral',
};

const TIPO_GRUPO_CLASS = {
  parcela_muito_atrasada: 'is-severe',
  parcela_atrasada: 'is-danger',
  parcela_vence_hoje: 'is-warning',
  parcela_vence_em_breve: 'is-info',
  recalculado_em_aberto: 'is-neutral',
};

const getTipoBadgeClass = (tipo) => TIPO_BADGE_CLASS[tipo] || 'is-default';
const getTipoGrupoClass = (tipo) => TIPO_GRUPO_CLASS[tipo] || 'is-default';

function LinhaParcelaNotificacao({
  notif,
  onMarcar,
  marcando,
  labelTipo,
  onAbrirEmprestimo,
  onIrPagamento,
  onAdicionarJuros,
  extras = 0,
}) {
  const badgeClass = getTipoBadgeClass(notif.tipo);
  const vencFormatado = notif.parcela_vencimento
    ? formatarData(notif.parcela_vencimento)
    : 'Sem vencimento';
  const refISO = hojeLocalISO();
  const diffDiasVenc = diffDias(notif.parcela_vencimento, refISO);
  const tempoTexto = statusTempo(notif.parcela_vencimento, refISO);
  const venceuEmTexto =
    diffDiasVenc != null && diffDiasVenc < 0
      ? `Parcela venceu há ${Math.abs(diffDiasVenc)} ${
          Math.abs(diffDiasVenc) === 1 ? 'dia' : 'dias'
        }`
      : null;

  const valorTotal = getTotalDevidoParcela({
    valor_total: notif.parcela_valor_total,
    juros_pendentes: notif.parcela_juros_pendentes,
    juros_adicionais: notif.parcela_juros_adicionais,
  });
  const valorCapital = Number(notif.parcela_valor_capital || 0);
  const valorJuros = Number(notif.parcela_valor_juros || 0);
  const valorPago = Number(notif.parcela_valor_pago || 0);
  const jurosPendentes = Number(notif.parcela_juros_pendentes || 0);
  const jurosAdicionais = Number(notif.parcela_juros_adicionais || 0);
  const emAberto = Math.max(0, valorTotal - valorPago);
  const temValorPago = valorPago > 0;
  const parcelaPaga =
    notif.parcela_pago === 1 ||
    notif.parcela_pago === '1' ||
    notif.parcela_pago === true ||
    (valorTotal > 0 && emAberto <= 0);
  const parcelaLabel =
    notif.parcela_numero != null
      ? `Parcela #${notif.parcela_numero}`
      : notif.parcela_id
      ? `Parcela #${notif.parcela_id}`
      : 'Parcela';
  const podeAdicionarJuros =
    notif.tipo === 'parcela_atrasada' ||
    notif.tipo === 'parcela_muito_atrasada';
  const mostrarVenceuEm =
    notif.tipo === 'parcela_atrasada' ||
    notif.tipo === 'parcela_muito_atrasada';
  const clienteNome = String(notif.cliente_nome || 'Cliente não informado').trim();
  const clienteIdLabel =
    notif.cliente_id !== null &&
    notif.cliente_id !== undefined &&
    notif.cliente_id !== ''
      ? `${notif.cliente_id} - ${clienteNome}`
      : clienteNome;
  const clienteLabel = clienteIdLabel.toLocaleUpperCase('pt-BR');
  const clienteMalPagador = isClienteMalPagador({
    mal_pagador: notif?.cliente_mal_pagador,
  });

  return (
    <article className={`notificacao-card${clienteMalPagador ? ' client-card--risk' : ''}`}>
      <div className="notificacao-card__header">
        <div className="notificacao-card__client">{clienteLabel}</div>
        {notif.cliente_telefone ? (
          <div className="notificacao-card__meta">
            Telefone: {notif.cliente_telefone}
          </div>
        ) : null}
        {notif.cliente_endereco ? (
          <div className="notificacao-card__meta">
            Endereço: {notif.cliente_endereco}
          </div>
        ) : null}
      </div>

      <div className="notificacao-card__badges">
        {notif.tipo ? (
          <span className={`notificacao-badge ${badgeClass}`}>
            {labelTipo || notif.tipo}
          </span>
        ) : null}
        {clienteMalPagador ? (
          <span className="badge-risk">Mal pagador</span>
        ) : null}
        {extras > 0 ? (
          <span
            className="notificacao-badge is-muted"
            title={`${extras} notificação(ões) similar(es) mais antiga(s) ocultada(s)`}
          >
            +{extras} anteriores
          </span>
        ) : null}
      </div>

      <div className="notificacao-card__content">
        <div className="notificacao-card__parcel">
          <div className="notificacao-card__parcel-title">{parcelaLabel}</div>
          <div className="notificacao-card__parcel-line">
            Vencimento: {vencFormatado}
          </div>
          {(mostrarVenceuEm ? venceuEmTexto : tempoTexto) ? (
            <div className="notificacao-card__parcel-status">
              {mostrarVenceuEm ? venceuEmTexto : tempoTexto}
            </div>
          ) : null}
        </div>
        <div className="notificacao-card__amounts">
          <div className="notificacao-card__amount-main">
            Valor da parcela: {formatarMoeda(valorTotal)}
          </div>
          <div className="notificacao-card__amount-breakdown">
            {renderLinhaJuros(
              {
                valor_capital: valorCapital,
                valor_juros: valorJuros,
                juros_pendentes: jurosPendentes,
                juros_adicionais: jurosAdicionais,
              },
              formatarMoeda
            )}
          </div>
          {temValorPago ? (
            <>
              <div className="notificacao-card__amount-secondary">
                Já pago: {formatarMoeda(valorPago)}
              </div>
              <div className="notificacao-card__amount-secondary">
                Em aberto: {formatarMoeda(emAberto)}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className="notificacao-card__footer">
        <div className="notificacao-card__actions">
          <button
            type="button"
            onClick={onAbrirEmprestimo}
            disabled={!notif.emprestimo_id}
            className="notificacao-action-btn is-primary"
          >
            Abrir empréstimo
          </button>
          {podeAdicionarJuros ? (
            <button
              type="button"
              onClick={onAdicionarJuros}
              disabled={!notif.emprestimo_id || !notif.parcela_id}
              className="notificacao-action-btn is-warning"
            >
              Adicionar juros
            </button>
          ) : null}
          <button
            type="button"
            onClick={onIrPagamento}
            disabled={!notif.emprestimo_id}
            className="notificacao-action-btn is-success"
          >
            Ir para pagamento
          </button>
        </div>

        {parcelaPaga ? (
          <button
            onClick={onMarcar}
            disabled={marcando}
            className="notificacao-action-btn is-mark-read"
          >
            {marcando ? 'Marcando...' : 'Marcar como lida'}
          </button>
        ) : null}
      </div>
    </article>
  );
}
export default function Notificacoes() {
  const { resolverCliente } = useClientesCatalogo();
  const location = useLocation();
  const [notificacoes, setNotificacoes] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [gerando, setGerando] = useState(false);
  const [mostrarClientesComNotificacoesDesligadas, setMostrarClientesComNotificacoesDesligadas] =
    useState(false);
  const [erro, setErro] = useState(null);
  const [marcando, setMarcando] = useState({});
  const [config, setConfig] = useState(CONFIG_DEFAULT);
  const [configModal, setConfigModal] = useState({ aberto: false, tipo: null });
  const [configEdicao, setConfigEdicao] = useState(CONFIG_DEFAULT);
  const [salvandoConfig, setSalvandoConfig] = useState(false);
  const [retornoContexto, setRetornoContexto] = useState(null);
  const [ordenacao, setOrdenacao] = useState(() => {
    try {
      const salvo = localStorage.getItem(ORDENACAO_NOTIFICACOES_KEY);
      return ORDENACOES_NOTIFICACOES_VALIDAS.has(salvo)
        ? salvo
        : 'ultimoTrabalhado';
    } catch {
      return 'ultimoTrabalhado';
    }
  });
  const [modoExibicao, setModoExibicao] = useState(() => {
    try {
      const salvo = localStorage.getItem(NOTIFICACOES_LAYOUT_KEY);
      return salvo === 'lista' ? 'lista' : 'grade';
    } catch {
      return 'grade';
    }
  });
  const [abertos, setAbertos] = useState(() => {
    const inicial = {};
    TIPO_ORDEM.forEach((t) => (inicial[t] = false)); // todos os grupos começam fechados
    return inicial;
  });
  const [filtroGrupo, setFiltroGrupo] = useState(() => {
    const inicial = {};
    TIPO_ORDEM.forEach((t) => (inicial[t] = ''));
    return inicial;
  });
  const [filtroGrupoId, setFiltroGrupoId] = useState(() => {
    const inicial = {};
    TIPO_ORDEM.forEach((t) => (inicial[t] = ''));
    return inicial;
  });
  const incluirClientesComNotificacoesDesligadas =
    mostrarClientesComNotificacoesDesligadas ||
    ordenacao === 'notificacoesDesligadas';

  useEffect(() => {
    try {
      localStorage.setItem(NOTIFICACOES_LAYOUT_KEY, modoExibicao);
    } catch {}
  }, [modoExibicao]);

  useEffect(() => {
    try {
      localStorage.setItem(ORDENACAO_NOTIFICACOES_KEY, ordenacao);
    } catch {}
  }, [ordenacao]);

  const carregarNotificacoes = async () => {
    setCarregando(true);
    setErro(null);
    try {
      const resp = await axios.get('/notificacoes', {
        params: {
          incluirDesligadas: incluirClientesComNotificacoesDesligadas ? '1' : undefined,
        },
      });
      const lista = resp.data?.notificacoes || [];
      setNotificacoes(lista);
    } catch (err) {
      const msg = parseError(err, 'Erro ao carregar notificações.');
      setErro(msg);
      notify.error('Sistema Empréstimos: ' + msg);
    } finally {
      setCarregando(false);
    }
  };

  const gerarParaHoje = async () => {
    setGerando(true);
    const hojeISO = hojeLocalISO();
    try {
      const resp = await axios.post('/notificacoes/run', {
        data: hojeISO,
      });

      const criadas = resp.data?.criadas;
      const dataBase = resp.data?.dataBase || hojeISO;

      if (typeof criadas === 'number') {
        notify.success(
          `Motor de notificações rodou para ${formatarData(
            dataBase
          )}. Criadas ${criadas} novas (ou já existentes foram ignoradas).`
        );
      } else {
        notify.success(
          `Motor de notificações rodou para ${formatarData(dataBase)}.`
        );
      }

      await carregarNotificacoes();
    } catch (err) {
      const msg = parseError(err, 'Erro ao gerar notificações.');
      setErro(msg);
      notify.error('Sistema Empréstimos: ' + msg);
    } finally {
      setGerando(false);
    }
  };

  const marcarComoLida = async (id) => {
    setMarcando((prev) => ({ ...prev, [id]: true }));
    try {
      await axios.post(`/notificacoes/${id}/lida`);
      setNotificacoes((lista) => lista.filter((n) => n.id !== id));
    } catch (err) {
      const msg = parseError(err, 'Erro ao marcar notificação como lida.');
      setErro(msg);
      notify.error('Sistema Empréstimos: ' + msg);
    } finally {
      setMarcando((prev) => {
        const novo = { ...prev };
        delete novo[id];
        return novo;
      });
    }
  };

  useEffect(() => {
    carregarNotificacoes();
  }, [incluirClientesComNotificacoesDesligadas]);

  useEffect(() => {
    window.addEventListener('notificacoes-cobranca-atualizadas', carregarNotificacoes);
    return () =>
      window.removeEventListener('notificacoes-cobranca-atualizadas', carregarNotificacoes);
  }, [incluirClientesComNotificacoesDesligadas]);

  const carregarConfig = async () => {
    try {
      const resp = await axios.get('/notificacoes/config');
      const cfg = resp.data?.config || CONFIG_DEFAULT;
      setConfig({
        ...CONFIG_DEFAULT,
        ...cfg,
      });
      setConfigEdicao({
        ...CONFIG_DEFAULT,
        ...cfg,
      });
    } catch (err) {
      console.error('[Notificacoes] erro ao carregar config:', err);
      notify.error('Erro ao carregar configurações de notificações.');
    }
  };

  useEffect(() => {
    carregarConfig();
  }, []);

  const navegar = (hash) => {
    if (!hash) return;
    window.location.hash = hash;
  };

  const salvarRetornoContexto = (contexto) => {
    const payload = {
      scrollY: window.scrollY || 0,
      tipo: contexto?.tipo || null,
      chaveCliente: contexto?.chaveCliente || null,
      at: Date.now(),
    };
    sessionStorage.setItem(RETORNO_NOTIFICACOES_KEY, JSON.stringify(payload));
  };

  const abrirEmprestimo = (emprestimoId, parcelaId, contextoRetorno = null) => {
    salvarRetornoContexto(contextoRetorno);

    if (emprestimoId) {
      const params = new URLSearchParams();
      params.set('emprestimo', emprestimoId);
      if (parcelaId) params.set('parcela', parcelaId);
      params.set('from', 'notificacoes');
      if (contextoRetorno?.tipoNotificacao) {
        params.set('tipoNotificacao', String(contextoRetorno.tipoNotificacao));
      }
      if (contextoRetorno?.notificacaoId) {
        params.set('notificacaoId', String(contextoRetorno.notificacaoId));
      }
      if (contextoRetorno?.clienteId) {
        params.set('cliente', String(contextoRetorno.clienteId));
      }
      if (contextoRetorno?.parcelaId && !parcelaId) {
        params.set('parcela', String(contextoRetorno.parcelaId));
      }
      navegar(`#/emprestimos?${params.toString()}`);
    } else {
      const params = new URLSearchParams();
      params.set('from', 'notificacoes');
      if (contextoRetorno?.tipoNotificacao) {
        params.set('tipoNotificacao', String(contextoRetorno.tipoNotificacao));
      }
      if (contextoRetorno?.notificacaoId) {
        params.set('notificacaoId', String(contextoRetorno.notificacaoId));
      }
      if (contextoRetorno?.clienteId) {
        params.set('cliente', String(contextoRetorno.clienteId));
      }
      if (contextoRetorno?.parcelaId) {
        params.set('parcela', String(contextoRetorno.parcelaId));
      }
      navegar(`#/emprestimos?${params.toString()}`);
    }
  };

  const irParaPagamento = (emprestimoId, parcelaId) => {
    if (emprestimoId) {
      const params = new URLSearchParams();
      params.set('emprestimo', emprestimoId);
      if (parcelaId) params.set('parcela', parcelaId);
      navegar(`#/pagamento?${params.toString()}`);
    } else {
      navegar('#/pagamento');
    }
  };

  const adicionarJuros = (emprestimoId, parcelaId) => {
    if (emprestimoId) {
      const params = new URLSearchParams();
      params.set('emprestimo', emprestimoId);
      if (parcelaId) params.set('parcela', parcelaId);
      params.set('juros', '1');
      navegar(`#/emprestimos?${params.toString()}`);
    } else {
      navegar('#/emprestimos');
    }
  };

  const isVazio = !carregando && notificacoes.length === 0;

  const notificacoesDedup = useMemo(() => {
    const map = {};
    const getTs = (n) => {
      const base = n?.data_referencia || n?.criado_em;
      const t = base ? Date.parse(base) : 0;
      return Number.isFinite(t) ? t : 0;
    };

    for (const n of notificacoes || []) {
      const key = `${n.tipo || 'sem_tipo'}|${n.parcela_id || 'sem_parcela'}`;
      const ts = getTs(n);
      if (!map[key]) {
        map[key] = { ...n, _dupExtras: 0, _ts: ts };
      } else {
        // Mantém a mais recente
        map[key]._dupExtras += 1;
        if (ts > map[key]._ts) {
          map[key] = { ...n, _dupExtras: map[key]._dupExtras, _ts: ts };
        }
      }
    }
    return Object.values(map);
  }, [notificacoes]);

  const gruposPorTipo = useMemo(() => {
    const grupos = {};
    TIPO_ORDEM.forEach((t) => {
      grupos[t] = [];
    });
    for (const n of notificacoesDedup) {
      const tipo = n.tipo || 'desconhecido';
      if (!grupos[tipo]) grupos[tipo] = [];
      grupos[tipo].push(n);
    }
    return grupos;
  }, [notificacoesDedup]);

  const agruparClientesPorLista = (listaNotificacoes = []) => {
    const porCliente = new Map();

    for (const n of listaNotificacoes || []) {
      const chaveCliente = getClienteGroupKey(n);
      const vencTs = getVencimentoTs(n.parcela_vencimento);
      const parcelaKey = getParcelaGroupKey(n);
      const valorDevidoParcela = getValorDevidoNotificacao(n);
      const atividadeTs = parseTs(n?.data_referencia || n?.criado_em);
      const clienteMalPagador = isClienteMalPagador({
        mal_pagador: n?.cliente_mal_pagador,
      });
      const clienteCriadoTs = parseTs(
        n?.cliente_criado_em ||
          n?.cliente_criadoEm ||
          n?.cliente_created_at ||
          n?.cliente_createdAt ||
          n?.cliente_data_cadastro ||
          n?.cliente_cadastrado_em
      );

      if (!porCliente.has(chaveCliente)) {
        const emprestimosSet = new Set();
        if (
          n.emprestimo_id !== null &&
          n.emprestimo_id !== undefined &&
          n.emprestimo_id !== ''
        ) {
          emprestimosSet.add(String(n.emprestimo_id));
        }

        porCliente.set(chaveCliente, {
          chaveCliente,
          cliente_id: n.cliente_id ?? null,
          cliente_cpf: n.cliente_cpf ?? null,
          cliente_nome: n.cliente_nome ?? '',
          mal_pagador: clienteMalPagador ? 1 : 0,
          cliente_receber_notificacoes_cobranca:
            n?.cliente_receber_notificacoes_cobranca ?? 1,
          parcelasSet: new Set([parcelaKey]),
          parcelasValorMap: new Map([[parcelaKey, valorDevidoParcela]]),
          parcelasValorAtrasoMap: new Map(
            TIPOS_ATRASO_SET.has(n.tipo) ? [[parcelaKey, valorDevidoParcela]] : []
          ),
          emprestimosSet,
          notificacoes: [n],
          minVencimentoTs: vencTs,
          totalDevido: valorDevidoParcela,
          totalDevidoAtrasado: TIPOS_ATRASO_SET.has(n.tipo)
            ? valorDevidoParcela
            : 0,
          ultimaAtividadeTs: atividadeTs,
          clienteCriadoTs,
          notificacaoPrincipal: n,
        });
        continue;
      }

      const grupo = porCliente.get(chaveCliente);
      if (clienteMalPagador) {
        grupo.mal_pagador = 1;
      }
      if (temNotificacoesDesligadas(n)) {
        grupo.cliente_receber_notificacoes_cobranca = 0;
      }
      grupo.notificacoes.push(n);
      grupo.parcelasSet.add(parcelaKey);
      if (!grupo.parcelasValorMap.has(parcelaKey)) {
        grupo.parcelasValorMap.set(parcelaKey, valorDevidoParcela);
        grupo.totalDevido += valorDevidoParcela;
      }
      if (
        TIPOS_ATRASO_SET.has(n.tipo) &&
        !grupo.parcelasValorAtrasoMap.has(parcelaKey)
      ) {
        grupo.parcelasValorAtrasoMap.set(parcelaKey, valorDevidoParcela);
        grupo.totalDevidoAtrasado += valorDevidoParcela;
      }
      if (
        n.emprestimo_id !== null &&
        n.emprestimo_id !== undefined &&
        n.emprestimo_id !== ''
      ) {
        grupo.emprestimosSet.add(String(n.emprestimo_id));
      }

      if (vencTs < grupo.minVencimentoTs) {
        grupo.minVencimentoTs = vencTs;
        grupo.notificacaoPrincipal = n;
      }
      if (atividadeTs > grupo.ultimaAtividadeTs) {
        grupo.ultimaAtividadeTs = atividadeTs;
      }
      if (clienteCriadoTs > 0) {
        if (!grupo.clienteCriadoTs || clienteCriadoTs < grupo.clienteCriadoTs) {
          grupo.clienteCriadoTs = clienteCriadoTs;
        }
      }
    }

    return Array.from(porCliente.values()).map((grupo) => ({
      ...grupo,
      parcelas_atrasadas: grupo.parcelasSet.size || grupo.notificacoes.length,
      emprestimos_afetados: grupo.emprestimosSet.size,
      total_devido: Number(grupo.totalDevido || 0),
      total_devido_atrasado: Number(grupo.totalDevidoAtrasado || 0),
      ultima_atividade_ts: Number(grupo.ultimaAtividadeTs || 0),
      cliente_criado_ts: Number(grupo.clienteCriadoTs || 0),
    }));
  };

  const ordenarClientesAgrupados = (a, b) => {
    const idNum = (cliente) => {
      const n = Number(cliente?.cliente_id);
      return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
    };
    const nomeKey = (cliente) => normalizarTextoBusca(cliente?.cliente_nome || '');
    const totalDevido = (cliente) => {
      const n = Number(cliente?.total_devido || 0);
      return Number.isFinite(n) ? n : 0;
    };
    const totalDevidoAtrasado = (cliente) => {
      const n = Number(cliente?.total_devido_atrasado || 0);
      return Number.isFinite(n) ? n : 0;
    };
    const criadoTs = (cliente) => {
      const ts = Number(cliente?.cliente_criado_ts || 0);
      return Number.isFinite(ts) && ts > 0 ? ts : 0;
    };
    const atividadeTs = (cliente) => {
      const ts = Number(cliente?.ultima_atividade_ts || 0);
      return Number.isFinite(ts) && ts > 0 ? ts : 0;
    };

    let diff = 0;
    switch (ordenacao) {
      case 'idCrescente':
        diff = idNum(a) - idNum(b);
        break;
      case 'idDecrescente':
        diff = idNum(b) - idNum(a);
        break;
      case 'nomeAZ':
        diff = nomeKey(a).localeCompare(nomeKey(b), 'pt-BR', {
          sensitivity: 'base',
        });
        break;
      case 'nomeZA':
        diff = nomeKey(b).localeCompare(nomeKey(a), 'pt-BR', {
          sensitivity: 'base',
        });
        break;
      case 'maisAntigos': {
        const aCriado = criadoTs(a);
        const bCriado = criadoTs(b);
        if (aCriado || bCriado) {
          diff = aCriado - bCriado;
          break;
        }
        diff = idNum(a) - idNum(b);
        break;
      }
      case 'maisNovos': {
        const aCriado = criadoTs(a);
        const bCriado = criadoTs(b);
        if (aCriado || bCriado) {
          diff = bCriado - aCriado;
          break;
        }
        diff = idNum(b) - idNum(a);
        break;
      }
      case 'maiorValor':
        diff = totalDevidoAtrasado(b) - totalDevidoAtrasado(a);
        if (diff === 0) diff = totalDevido(b) - totalDevido(a);
        break;
      case 'menorValor':
        diff = totalDevidoAtrasado(a) - totalDevidoAtrasado(b);
        if (diff === 0) diff = totalDevido(a) - totalDevido(b);
        break;
      case 'malPagadores':
      case 'notificacoesDesligadas':
        diff = nomeKey(a).localeCompare(nomeKey(b), 'pt-BR', {
          sensitivity: 'base',
        });
        break;
      case 'ultimoTrabalhado':
      default: {
        const aAtividade = atividadeTs(a);
        const bAtividade = atividadeTs(b);
        if (aAtividade || bAtividade) {
          diff = bAtividade - aAtividade;
          break;
        }
        diff = a.minVencimentoTs - b.minVencimentoTs;
        break;
      }
    }

    if (diff !== 0) return diff;
    if (a.minVencimentoTs !== b.minVencimentoTs) {
      return a.minVencimentoTs - b.minVencimentoTs;
    }
    const nomeDiff = nomeKey(a).localeCompare(nomeKey(b), 'pt-BR', {
      sensitivity: 'base',
    });
    if (nomeDiff !== 0) return nomeDiff;
    return idNum(a) - idNum(b);
  };

  const gruposClientesPorTipo = useMemo(() => {
    const grupos = {};
    TIPO_ORDEM.forEach((tipo) => {
      const listaTipo = gruposPorTipo[tipo] || [];
      const agrupados = agruparClientesPorLista(listaTipo);
      const filtrados =
        ordenacao === 'malPagadores'
          ? agrupados.filter(isClienteMalPagador)
          : ordenacao === 'notificacoesDesligadas'
            ? agrupados.filter(temNotificacoesDesligadas)
            : agrupados;
      grupos[tipo] = filtrados.sort(ordenarClientesAgrupados);
    });
    return grupos;
  }, [gruposPorTipo, ordenacao]);

  const toggleGrupo = (tipo) => {
    setAbertos((prev) => ({ ...prev, [tipo]: !prev[tipo] }));
  };

  const abrirConfig = (tipo) => {
    setConfigModal({ aberto: true, tipo });
    setConfigEdicao({ ...config });
  };

  const fecharConfig = () => {
    setConfigModal({ aberto: false, tipo: null });
  };

  const salvarConfigApi = async () => {
    try {
      setSalvandoConfig(true);
      const payload = {
        venceEmBreveDias: Number(configEdicao.venceEmBreveDias),
      };
      const resp = await axios.post('/notificacoes/config', payload);
      const cfg = resp.data?.config || payload;
      setConfig({ ...CONFIG_DEFAULT, ...cfg });
      setConfigEdicao({ ...CONFIG_DEFAULT, ...cfg });
      notify.success('Configurações de notificações salvas.');
      fecharConfig();
      await carregarNotificacoes();
    } catch (err) {
      const msg = parseError(err, 'Erro ao salvar configurações.');
      notify.error(msg);
    } finally {
      setSalvandoConfig(false);
    }
  };

  const restaurarPadrao = async () => {
    try {
      setSalvandoConfig(true);
      const resp = await axios.post('/notificacoes/config/default');
      const cfg = resp.data?.config || CONFIG_DEFAULT;
      setConfig({ ...CONFIG_DEFAULT, ...cfg });
      setConfigEdicao({ ...CONFIG_DEFAULT, ...cfg });
      notify.success('Configurações restauradas para o padrão.');
    } catch (err) {
      const msg = parseError(err, 'Erro ao restaurar padrão.');
      notify.error(msg);
    } finally {
      setSalvandoConfig(false);
    }
  };

  // Contagem total em cada grupo (para mostrar no cabeçalho)
  const contagemPorTipo = useMemo(() => {
    const c = {};
    TIPO_ORDEM.forEach((t) => {
      c[t] = (gruposPorTipo[t] || []).length;
    });
    return c;
  }, [gruposPorTipo]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const deveRestaurar = params.get('retornoNotificacoes') === '1';
    if (!deveRestaurar) return;

    const raw = sessionStorage.getItem(RETORNO_NOTIFICACOES_KEY);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      setRetornoContexto(parsed);
      if (parsed?.tipo && TIPO_ORDEM.includes(parsed.tipo)) {
        setAbertos((prev) => ({ ...prev, [parsed.tipo]: true }));
      }
    } catch {
      sessionStorage.removeItem(RETORNO_NOTIFICACOES_KEY);
    }
  }, [location.search]);

  useEffect(() => {
    if (!retornoContexto || carregando) return;

    const timer = window.setTimeout(() => {
      let restaurado = false;

      const chaveCliente = String(retornoContexto.chaveCliente || '').replace(/"/g, '\\"');
      if (chaveCliente) {
        const el = document.querySelector(
          `[data-notif-cliente-key="${chaveCliente}"]`
        );
        if (el && el.scrollIntoView) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          restaurado = true;
        }
      }

      if (!restaurado && Number.isFinite(Number(retornoContexto.scrollY))) {
        window.scrollTo({
          top: Math.max(0, Number(retornoContexto.scrollY)),
          behavior: 'smooth',
        });
      }

      sessionStorage.removeItem(RETORNO_NOTIFICACOES_KEY);
      setRetornoContexto(null);
    }, 90);

    return () => window.clearTimeout(timer);
  }, [retornoContexto, carregando, gruposClientesPorTipo]);

  return (
    <div className="notificacoes-page">
      <header className="notificacoes-header">
        <div className="notificacoes-header__content">
          <h2 className="notificacoes-header__title">Notificações</h2>
          <p className="notificacoes-header__subtitle">
            Avisos de parcelas que vencem hoje, estão atrasadas ou que vencem em
            breve (até 3 dias). A lista mostra apenas notificações pendentes.
          </p>
        </div>

        <div className="notificacoes-toolbar">
          <div className="notificacoes-toolbar__actions">
            <button
              onClick={carregarNotificacoes}
              disabled={carregando}
              className="notificacoes-toolbar__btn is-secondary"
            >
              {carregando ? 'Atualizando...' : 'Atualizar lista'}
            </button>
            <button
              onClick={gerarParaHoje}
              disabled={gerando}
              className="notificacoes-toolbar__btn is-primary"
            >
              {gerando ? 'Gerando...' : 'Rodar motor para hoje'}
            </button>
            <select
              value={ordenacao}
              onChange={(e) => setOrdenacao(e.target.value)}
              title="Ordenar clientes"
              aria-label="Ordenar clientes"
              className="notificacoes-toolbar__select"
            >
              <option value="idCrescente">ID Crescente</option>
              <option value="idDecrescente">ID Decrescente</option>
              <option value="nomeAZ">Nome A-Z</option>
              <option value="nomeZA">Nome Z-A</option>
              <option value="maisAntigos">Clientes mais antigos</option>
              <option value="maisNovos">Clientes mais novos</option>
              <option value="maiorValor">Maior valor devido</option>
              <option value="menorValor">Menor valor devido</option>
              <option value="ultimoTrabalhado">Último trabalhado</option>
              <option value="malPagadores">Mal pagadores</option>
              <option value="notificacoesDesligadas">Notificações desligadas</option>
            </select>
            <label className="notificacoes-toolbar__checkbox">
              <input
                type="checkbox"
                checked={mostrarClientesComNotificacoesDesligadas}
                onChange={(e) =>
                  setMostrarClientesComNotificacoesDesligadas(e.target.checked)
                }
              />
              <span>Mostrar clientes com notificações desligadas</span>
            </label>
            <div className="notificacoes-toolbar__view">
              <button
                type="button"
                onClick={() => setModoExibicao('lista')}
                title="Exibir em lista"
                aria-label="Exibir em lista"
                aria-pressed={modoExibicao === 'lista'}
                className={`notificacoes-view-toggle-btn${
                  modoExibicao === 'lista' ? ' is-active' : ''
                }`}
              >
                {'\u2630'}
              </button>
              <button
                type="button"
                onClick={() => setModoExibicao('grade')}
                title="Exibir lado a lado"
                aria-label="Exibir lado a lado"
                aria-pressed={modoExibicao === 'grade'}
                className={`notificacoes-view-toggle-btn${
                  modoExibicao === 'grade' ? ' is-active' : ''
                }`}
              >
                {'\u25A6'}
              </button>
            </div>
          </div>

          <div className="notificacoes-toolbar__summary">
            <span className="notificacoes-summary-pill is-severe">
              Muito atrasadas: <strong>{contagemPorTipo.parcela_muito_atrasada || 0}</strong>
            </span>
            <span className="notificacoes-summary-pill is-danger">
              Atrasadas: <strong>{contagemPorTipo.parcela_atrasada || 0}</strong>
            </span>
            <span className="notificacoes-summary-pill is-warning">
              Hoje: <strong>{contagemPorTipo.parcela_vence_hoje || 0}</strong>
            </span>
            <span className="notificacoes-summary-pill is-info">
              Em breve: <strong>{contagemPorTipo.parcela_vence_em_breve || 0}</strong>
            </span>
            <span className="notificacoes-summary-pill is-neutral">
              Recalculados: <strong>{contagemPorTipo.recalculado_em_aberto || 0}</strong>
            </span>
          </div>
        </div>
      </header>

      {erro ? <div className="notificacoes-alert is-error">{erro}</div> : null}

      {carregando && notificacoes.length === 0 ? (
        <p className="notificacoes-feedback">Carregando notificações...</p>
      ) : null}

      {isVazio ? (
        <p className="notificacoes-feedback">Nenhuma notificação pendente.</p>
      ) : null}

      {!isVazio ? (
        <div className="notificacoes-grupos">
          {TIPO_ORDEM.map((tipo) => {
            const itens = gruposPorTipo[tipo] || [];
            const clientes = gruposClientesPorTipo[tipo] || [];
            const label = TIPO_LABELS[tipo] || tipo;
            const aberto = abertos[tipo];
            const buscaGrupo = filtroGrupo[tipo] || '';
            const buscaGrupoId = filtroGrupoId[tipo] || '';
            const clientesFiltrados = filtrarClientesPorBusca(clientes, buscaGrupo, buscaGrupoId);
            const grupoClass = getTipoGrupoClass(tipo);

            return (
              <section key={tipo} className={`notificacoes-grupo ${grupoClass}`}>
                <div className="notificacoes-grupo__header">
                  <button
                    type="button"
                    onClick={() => toggleGrupo(tipo)}
                    className={`notificacoes-grupo-toggle${aberto ? ' is-open' : ''}`}
                  >
                    <span className="notificacoes-grupo-toggle__left">
                      <span className="notificacoes-grupo-toggle__arrow">
                        {'\u25B6'}
                      </span>
                      <span className="notificacoes-grupo-toggle__title">
                        {label}
                      </span>
                    </span>

                    <span className="notificacoes-grupo-toggle__count">
                      {itens.length} notificação(ões)
                    </span>
                  </button>

                  {tipo === 'parcela_vence_em_breve' ? (
                    <button
                      type="button"
                      onClick={() => abrirConfig(tipo)}
                      title="Configurar este grupo"
                      className="notificacoes-grupo-config-btn"
                    >
                      Config.
                    </button>
                  ) : null}
                </div>

                {aberto && clientes.length > 0 ? (
                  <div className="notificacoes-grupo__search">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={buscaGrupoId}
                      onChange={(e) =>
                        setFiltroGrupoId((prev) => ({
                          ...prev,
                          [tipo]: e.target.value.replace(/\D/g, ''),
                        }))
                      }
                      placeholder="ID"
                      aria-label={`Pesquisar cliente por ID em ${label}`}
                      className="notificacoes-grupo__search-id"
                    />
                    <input
                      type="text"
                      value={buscaGrupo}
                      onChange={(e) =>
                        setFiltroGrupo((prev) => ({
                          ...prev,
                          [tipo]: e.target.value,
                        }))
                      }
                      placeholder="Pesquisar por nome neste grupo"
                      className="notificacoes-grupo__search-input"
                    />
                  </div>
                ) : null}

                {aberto ? (
                  clientes.length === 0 ? (
                    <p className="notificacoes-grupo__feedback">
                      Nenhuma notificação neste grupo.
                    </p>
                  ) : clientesFiltrados.length === 0 ? (
                    <p className="notificacoes-grupo__feedback">
                      Nenhum resultado para "{buscaGrupo || buscaGrupoId}" neste grupo.
                    </p>
                  ) : (
                    <div
                      className={`notificacoes-clientes-grid ${
                        modoExibicao === 'lista' ? 'is-lista' : 'is-grade'
                      }`}
                    >
                      {clientesFiltrados.map((clienteGrupo) => {
                        const clienteNome = String(
                          clienteGrupo.cliente_nome || 'Cliente não informado'
                        ).trim();
                        const clienteMalPagador = isClienteMalPagador(clienteGrupo);
                        const totalParcelas = Number(clienteGrupo.parcelas_atrasadas || 0);
                        const totalEmprestimos = Number(clienteGrupo.emprestimos_afetados || 0);
                        const resumoLinha = `${totalParcelas} parcela${
                          totalParcelas === 1 ? '' : 's'
                        } • ${totalEmprestimos} empréstimo${
                          totalEmprestimos === 1 ? '' : 's'
                        }`;
                        const principal =
                          clienteGrupo.notificacaoPrincipal ||
                          (clienteGrupo.notificacoes && clienteGrupo.notificacoes[0]) ||
                          null;

                        return (
                          <button
                            key={clienteGrupo.chaveCliente}
                            type="button"
                            className={`notificacoes-cliente-item notificacoes-cliente-resumo${
                              clienteMalPagador ? ' client-card--risk' : ''
                            }`}
                            data-notif-cliente-key={clienteGrupo.chaveCliente}
                            onClick={() =>
                              abrirEmprestimo(
                                principal?.emprestimo_id,
                                principal?.parcela_id,
                                {
                                  chaveCliente: clienteGrupo.chaveCliente,
                                  tipo,
                                  tipoNotificacao: principal?.tipo || tipo,
                                  notificacaoId: principal?.id,
                                  clienteId: principal?.cliente_id,
                                  parcelaId: principal?.parcela_id,
                                }
                              )
                            }
                          >
                            <span className="notificacoes-cliente-resumo__left">
                              <span className="notificacoes-cliente-resumo__arrow">
                                {'\u25B6'}
                              </span>
                              <ClienteIdentity
                                cliente={resolverCliente(
                                  clienteGrupo.cliente_id,
                                  clienteNome
                                )}
                                avatarSize={38}
                                secondary={
                                  clienteGrupo.cliente_id != null
                                    ? `ID ${clienteGrupo.cliente_id}`
                                    : null
                                }
                                nameClassName="notificacoes-cliente-resumo__title"
                              />
                              {clienteMalPagador ? (
                                <span className="badge-risk">Mal pagador</span>
                              ) : null}
                            </span>

                            <span
                              className="notificacoes-cliente-resumo__meta"
                              title={resumoLinha}
                            >
                              {resumoLinha}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}

      {configModal.aberto ? (
        <div className="notificacoes-modal-backdrop">
          <div className="notificacoes-modal">
            <div className="notificacoes-modal__header">
              <h3 className="notificacoes-modal__title">
                Configurar: {TIPO_LABELS[configModal.tipo] || configModal.tipo}
              </h3>
              <button
                type="button"
                onClick={fecharConfig}
                className="notificacoes-modal__close"
              >
                Fechar
              </button>
            </div>

            {configModal.tipo === 'parcela_vence_em_breve' ? (
              <label className="notificacoes-modal__field">
                <span>Quantos dias antes quer ser avisado?</span>
                <input
                  type="number"
                  min="1"
                  value={configEdicao.venceEmBreveDias}
                  onChange={(e) =>
                    setConfigEdicao((prev) => ({
                      ...prev,
                      venceEmBreveDias: Number(e.target.value),
                    }))
                  }
                  className="notificacoes-modal__input"
                />
              </label>
            ) : null}

            <div className="notificacoes-modal__actions">
              <button
                type="button"
                onClick={restaurarPadrao}
                disabled={salvandoConfig}
                className="notificacoes-toolbar__btn is-secondary"
              >
                Restaurar padrão
              </button>

              <div className="notificacoes-modal__actions-right">
                <button
                  type="button"
                  onClick={fecharConfig}
                  className="notificacoes-toolbar__btn is-secondary"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={salvarConfigApi}
                  disabled={salvandoConfig}
                  className="notificacoes-toolbar__btn is-primary"
                >
                  {salvandoConfig ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <Auditoria />
    </div>
  );
}
