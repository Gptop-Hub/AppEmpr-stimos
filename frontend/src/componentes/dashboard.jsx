import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { autorizarProtecao } from '../security/seguranca.js';
import { NavLink } from 'react-router-dom';
import { AppIcon, MENU_ITEMS } from './menu';
import notify from '../ui/notify';
import RelatorioFinanceiroPainel from './RelatorioFinanceiroPainel';
import './dashboard.css';

const MODULE_COPY = Object.freeze({
  '/emprestimos': {
    title: 'Empréstimos',
    description: 'Gerencie contratos, parcelas e condições de crédito.',
  },
  '/clientes': {
    title: 'Clientes',
    description: 'Cadastre clientes e acompanhe dados da carteira.',
  },
  '/pagamento': {
    title: 'Pagamentos',
    description: 'Registre recebimentos, quitações e movimentações.',
  },
  '/notificacoes': {
    title: 'Notificações',
    description: 'Monitore atrasos, vencimentos e alertas do sistema.',
  },
  '/fluxo-caixa': {
    title: 'Fluxo de Caixa',
    description: 'Acompanhe entradas, saídas e saldo consolidado.',
  },
  '/backup': {
    title: 'Backup',
    description: 'Proteja a base e restaure informações com segurança.',
  },
  '/simulacao': {
    title: 'Simulação',
    description: 'Simule empréstimos e condições de pagamento.',
  },
  '/atualizacoes': {
    title: 'Atualizações',
    description: 'Verifique novidades e estado da versão instalada.',
  },
  '/historico': {
    title: 'Histórico',
    description: 'Consulte versões anteriores e trilhas de alteração.',
  },
});

const MAIN_MODULE_ORDER = Object.freeze([
  '/emprestimos',
  '/clientes',
  '/pagamento',
  '/notificacoes',
  '/fluxo-caixa',
]);

const SUPPORT_MODULE_ORDER = Object.freeze([
  '/backup',
  '/simulacao',
  '/atualizacoes',
  '/historico',
]);

const SHOW_ADMIN_PURGE_ACTIONS = true;

const UPDATE_ATTENTION_STAGES = new Set(['available', 'downloaded']);

const UPDATE_STAGE_LABELS = Object.freeze({
  available: 'Atualização disponível',
  downloading: 'Baixando atualização',
  downloaded: 'Pronta para instalar',
});

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toSafeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function formatCompactNumber(value) {
  if (!Number.isFinite(value)) return '--';
  return new Intl.NumberFormat('pt-BR', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCurrencyBRL(value) {
  if (!Number.isFinite(value)) return '--';
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDateTime(value) {
  if (!value) return '--';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return '--';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(dt);
}

function todayLocalISO() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function getResumoPrevistoFromParcelas(parcelas = [], dataISO) {
  const resumo = {
    total: 0,
    capital: 0,
    juros: 0,
  };

  (parcelas || []).forEach((parcela) => {
    const vencISO = String(parcela?.vencimento || '').slice(0, 10);
    if (vencISO && dataISO && vencISO !== dataISO) return;

    const valorTotal = toSafeNumber(parcela?.valor_total);
    const valorCapital = toSafeNumber(parcela?.valor_capital);
    const valorJuros = toSafeNumber(parcela?.valor_juros);
    const jurosAdicionais = toSafeNumber(parcela?.juros_adicionais);
    const jurosPendentes = toSafeNumber(parcela?.juros_pendentes);

    const totalBruto =
      valorTotal > 0 || jurosAdicionais > 0
        ? valorTotal + jurosAdicionais
        : valorCapital + valorJuros + jurosAdicionais + jurosPendentes;

    resumo.total += Math.max(0, totalBruto);
    resumo.capital += valorCapital;
    resumo.juros += valorJuros + jurosAdicionais + jurosPendentes;
  });

  return {
    total: Number(resumo.total.toFixed(2)),
    capital: Number(resumo.capital.toFixed(2)),
    juros: Number(resumo.juros.toFixed(2)),
  };
}

function normalizeRecebidoHojeFromFluxo(raw = {}) {
  return {
    total: toFiniteNumber(raw?.total_recebido) ?? 0,
    capital: toFiniteNumber(raw?.total_capital_recebido) ?? 0,
    juros: toFiniteNumber(raw?.total_juros_recebido) ?? 0,
  };
}

function createBucket() {
  return {
    total: 0,
    capital: 0,
    juros: 0,
  };
}

function createRecebidoClassificadoVazio() {
  return {
    parcelasHoje: createBucket(),
    atrasados: createBucket(),
    antecipado: createBucket(),
    naoClassificado: createBucket(),
  };
}

function normalizeRecebidoClassificado(raw = {}) {
  return {
    parcelasHoje: {
      total: toFiniteNumber(raw?.parcelasHoje?.total) ?? 0,
      capital: toFiniteNumber(raw?.parcelasHoje?.capital) ?? 0,
      juros: toFiniteNumber(raw?.parcelasHoje?.juros) ?? 0,
    },
    atrasados: {
      total: toFiniteNumber(raw?.atrasados?.total) ?? 0,
      capital: toFiniteNumber(raw?.atrasados?.capital) ?? 0,
      juros: toFiniteNumber(raw?.atrasados?.juros) ?? 0,
    },
    antecipado: {
      total: toFiniteNumber(raw?.antecipado?.total) ?? 0,
      capital: toFiniteNumber(raw?.antecipado?.capital) ?? 0,
      juros: toFiniteNumber(raw?.antecipado?.juros) ?? 0,
    },
    naoClassificado: {
      total: toFiniteNumber(raw?.naoClassificado?.total) ?? 0,
      capital: toFiniteNumber(raw?.naoClassificado?.capital) ?? 0,
      juros: toFiniteNumber(raw?.naoClassificado?.juros) ?? 0,
    },
  };
}

function classifyRecebidoFromFluxoLinhas(linhas = [], dataISO) {
  const resumo = createRecebidoClassificadoVazio();

  (linhas || []).forEach((linha) => {
    const tipo = String(linha?.tipo || '').toUpperCase();
    const categoria = String(linha?.categoria || '').toUpperCase();
    if (tipo !== 'ENTRADA') return;
    if (categoria && categoria !== 'PAGAMENTO') return;

    const total = toSafeNumber(linha?.valor_total);
    const capital = toSafeNumber(linha?.valor_capital);
    const juros = toSafeNumber(linha?.valor_juros);
    const vencISO = String(linha?.data_vencimento || '').slice(0, 10);

    let bucket = resumo.naoClassificado;
    if (vencISO && /^\d{4}-\d{2}-\d{2}$/.test(vencISO)) {
      if (vencISO === dataISO) bucket = resumo.parcelasHoje;
      else if (vencISO < dataISO) bucket = resumo.atrasados;
      else bucket = resumo.antecipado;
    }

    bucket.total += total;
    bucket.capital += capital;
    bucket.juros += juros;
  });

  const normalizeBucket = (bucket) => ({
    total: Number(bucket.total.toFixed(2)),
    capital: Number(bucket.capital.toFixed(2)),
    juros: Number(bucket.juros.toFixed(2)),
  });

  return {
    parcelasHoje: normalizeBucket(resumo.parcelasHoje),
    atrasados: normalizeBucket(resumo.atrasados),
    antecipado: normalizeBucket(resumo.antecipado),
    naoClassificado: normalizeBucket(resumo.naoClassificado),
  };
}

function buildModulesByRoute(items) {
  const map = new Map();
  (items || []).forEach((item) => {
    if (item && item.to) map.set(item.to, item);
  });
  return map;
}

function normalizeDailySummary(raw = {}) {
  const previstoRaw = raw?.previstoHoje || {};
  const recebidoRaw = raw?.recebidoHoje || {};
  const recebidoClassificadoRaw =
    raw?.recebidoHojeClassificado || raw?.recebidoHojeDetalhado || {};

  return {
    data: raw?.data || todayLocalISO(),
    previstoHoje: {
      total: toFiniteNumber(previstoRaw.total) ?? 0,
      capital: toFiniteNumber(previstoRaw.capital) ?? 0,
      juros: toFiniteNumber(previstoRaw.juros) ?? 0,
    },
    recebidoHoje: {
      total: toFiniteNumber(recebidoRaw.total) ?? 0,
      capital: toFiniteNumber(recebidoRaw.capital) ?? 0,
      juros: toFiniteNumber(recebidoRaw.juros) ?? 0,
    },
    recebidoHojeClassificado: normalizeRecebidoClassificado(
      recebidoClassificadoRaw
    ),
  };
}

export default function Dashboard() {
  const [overview, setOverview] = useState({
    clientes: null,
    emprestimos: null,
    resumoDiario: normalizeDailySummary(),
    pendentesHoje: 0,
    totalNotificacoes: 0,
    ultimoBackupEm: null,
    backendOnline: null,
  });
  const [dailyDetailsOpen, setDailyDetailsOpen] = useState({
    previsto: false,
    recebido: false,
  });
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [appVersion, setAppVersion] = useState('-');
  const [updateStage, setUpdateStage] = useState('idle');
  const [isPurging, setIsPurging] = useState(false);

  const modulesByRoute = useMemo(() => buildModulesByRoute(MENU_ITEMS), []);

  useEffect(() => {
    let isAlive = true;

    const loadAppVersion = async () => {
      try {
        const version = await window?.appInfo?.version?.();
        if (!isAlive) return;
        if (version) setAppVersion(String(version));
      } catch (_) {}
    };

    loadAppVersion();

    return () => {
      isAlive = false;
    };
  }, []);

  useEffect(() => {
    let isAlive = true;

    const applyStage = (stageValue) => {
      if (!isAlive || !stageValue) return;
      setUpdateStage(String(stageValue));
    };

    const loadUpdateStatus = async () => {
      try {
        const status = await window?.updates?.getStatus?.();
        applyStage(status?.stage);
      } catch (_) {}
    };

    loadUpdateStatus();

    const unsub = window?.updates?.onStatus?.((payload) => {
      applyStage(payload?.stage);
    });

    return () => {
      isAlive = false;
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  useEffect(() => {
    let isAlive = true;

    const loadOverview = async () => {
      const hojeISO = todayLocalISO();

      const [
        backupResult,
        resumoDiarioResult,
        notificacoesResult,
        healthResult,
        fluxoResumoResult,
        parcelasPorDataResult,
        fluxoLinhasResult,
      ] =
        await Promise.allSettled([
          axios.get('/backup/now', { headers: { 'Cache-Control': 'no-store' } }),
          axios.get('/relatorios/home/resumo-diario', { headers: { 'Cache-Control': 'no-store' } }),
          axios.get('/notificacoes', { headers: { 'Cache-Control': 'no-store' } }),
          axios.get('/health', { headers: { 'Cache-Control': 'no-store' } }),
          axios.get('/fluxo-caixa/resumo', {
            headers: { 'Cache-Control': 'no-store' },
            params: { periodo: 'dia', de: hojeISO, ate: hojeISO },
          }),
          axios.get('/notificacoes/parcelas-por-data', {
            headers: { 'Cache-Control': 'no-store' },
            params: { data: hojeISO, incluirPagas: 1 },
          }),
          axios.get('/fluxo-caixa/linhas', {
            headers: { 'Cache-Control': 'no-store' },
            params: { periodo: 'dia', de: hojeISO, ate: hojeISO },
          }),
        ]);

      if (!isAlive) return;

      setOverview((prev) => {
        const next = { ...prev };

        if (backupResult.status === 'fulfilled') {
          const contagens = backupResult.value?.data?.contagens || {};
          next.clientes = toFiniteNumber(contagens.clientes);
          next.emprestimos = toFiniteNumber(contagens.emprestimos);
          next.ultimoBackupEm = backupResult.value?.data?.file?.mtime || null;
        }

        const notificacoesLista = Array.isArray(notificacoesResult.value?.data?.notificacoes)
          ? notificacoesResult.value.data.notificacoes
          : [];

        const resumoDiarioApi =
          resumoDiarioResult.status === 'fulfilled'
            ? normalizeDailySummary(resumoDiarioResult.value?.data || {})
            : normalizeDailySummary({ data: hojeISO });

        const parcelasDoDia = Array.isArray(parcelasPorDataResult.value?.data?.parcelas)
          ? parcelasPorDataResult.value.data.parcelas
          : [];
        const previstoFallback = getResumoPrevistoFromParcelas(parcelasDoDia, hojeISO);

        let resumoDiarioFinal = resumoDiarioApi;

        const deveAplicarFallbackPrevisto =
          resumoDiarioResult.status !== 'fulfilled' ||
          toSafeNumber(resumoDiarioApi?.previstoHoje?.total) <= 0.009;

        if (deveAplicarFallbackPrevisto && previstoFallback.total > 0) {
          resumoDiarioFinal = {
            ...resumoDiarioFinal,
            previstoHoje: previstoFallback,
          };
        }

        let recebidoClassificadoFallback = createRecebidoClassificadoVazio();
        if (fluxoLinhasResult.status === 'fulfilled') {
          const linhas = Array.isArray(fluxoLinhasResult.value?.data?.linhas)
            ? fluxoLinhasResult.value.data.linhas
            : [];
          recebidoClassificadoFallback = classifyRecebidoFromFluxoLinhas(
            linhas,
            hojeISO
          );
        }

        if (fluxoResumoResult.status === 'fulfilled') {
          const recebidoFallback = normalizeRecebidoHojeFromFluxo(
            fluxoResumoResult.value?.data || {}
          );

          const deveAplicarFallbackRecebido =
            resumoDiarioResult.status !== 'fulfilled' ||
            toSafeNumber(resumoDiarioApi?.recebidoHoje?.total) <= 0.009;

          if (deveAplicarFallbackRecebido) {
            resumoDiarioFinal = {
              ...resumoDiarioFinal,
              recebidoHoje: recebidoFallback,
            };
          }
        }

        const classificadoApi = normalizeRecebidoClassificado(
          resumoDiarioApi?.recebidoHojeClassificado || {}
        );
        const totalClassificadoApi =
          toSafeNumber(classificadoApi.parcelasHoje.total) +
          toSafeNumber(classificadoApi.atrasados.total) +
          toSafeNumber(classificadoApi.antecipado.total) +
          toSafeNumber(classificadoApi.naoClassificado.total);
        const totalClassificadoFallback =
          toSafeNumber(recebidoClassificadoFallback.parcelasHoje.total) +
          toSafeNumber(recebidoClassificadoFallback.atrasados.total) +
          toSafeNumber(recebidoClassificadoFallback.antecipado.total) +
          toSafeNumber(recebidoClassificadoFallback.naoClassificado.total);

        const deveAplicarFallbackClassificado =
          resumoDiarioResult.status !== 'fulfilled' ||
          totalClassificadoApi <= 0.009;

        resumoDiarioFinal = {
          ...resumoDiarioFinal,
          recebidoHojeClassificado:
            deveAplicarFallbackClassificado && totalClassificadoFallback > 0
              ? recebidoClassificadoFallback
              : classificadoApi,
        };

        const algumaFonteResumoDisponivel =
          resumoDiarioResult.status === 'fulfilled' ||
          parcelasPorDataResult.status === 'fulfilled' ||
          fluxoResumoResult.status === 'fulfilled' ||
          fluxoLinhasResult.status === 'fulfilled';
        if (algumaFonteResumoDisponivel) {
          next.resumoDiario = resumoDiarioFinal;
        }

        if (notificacoesResult.status === 'fulfilled') {
          const lista = notificacoesLista;
          next.totalNotificacoes = lista.length;
          next.pendentesHoje = lista.filter(
            (item) =>
              item?.tipo === 'parcela_vence_hoje' &&
              String(item?.data_referencia || '') === hojeISO
          ).length;
        }

        const healthPayload = healthResult.value?.data;
        next.backendOnline =
          healthResult.status === 'fulfilled' &&
          healthPayload?.ok === true &&
          healthPayload?.service === 'app-emprestimos-backend' &&
          Boolean(healthPayload?.dbPath) &&
          Boolean(healthPayload?.appDataDir);
        return next;
      });

      setLastSyncAt(new Date());
    };

    loadOverview();
    const intervalId = window.setInterval(loadOverview, 60_000);

    return () => {
      isAlive = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const updateBadgeLabel = UPDATE_STAGE_LABELS[updateStage] || null;

  const handlePurgeAll = async () => {
    if (isPurging) return;

    const confirmed = await notify.confirm(
      'Esta ação apagará permanentemente clientes, empréstimos, parcelas, pagamentos, históricos, notificações, dados do assistente, backups internos e uploads. Não será possível desfazer.',
      {
        title: 'Excluir absolutamente tudo?',
        okText: 'Continuar',
        cancelText: 'Cancelar',
      }
    );
    if (!confirmed) return;

    const phrase = await notify.prompt('Digite EXCLUIR TUDO para confirmar:', {
      title: 'Confirmação final',
      placeholder: 'EXCLUIR TUDO',
      maxLength: 20,
      okText: 'Confirmar frase',
      cancelText: 'Cancelar',
    });
    if (phrase === null) return;
    if (String(phrase).trim().toUpperCase() !== 'EXCLUIR TUDO') {
      await notify.error('A frase de confirmação está incorreta. Nada foi excluído.');
      return;
    }

    const autorizacao = await autorizarProtecao('apagar_todos_dados');
    if (!autorizacao) return;

    setIsPurging(true);
    try {
      await axios.post(
        '/sistema/excluir-tudo',
        { confirmation: 'EXCLUIR TUDO' },
        { ...autorizacao, timeout: 120_000 }
      );

      localStorage.clear();
      sessionStorage.clear();
      await notify.warn(
        'Todos os dados internos foram excluídos. O aplicativo será recarregado vazio.',
        { title: 'Exclusão concluída' }
      );
      window.location.reload();
    } catch (error) {
      const status = error?.response?.status;
      const apiMessage = error?.response?.data?.error;
      const databaseCleared = error?.response?.data?.databaseCleared === true;
      if (status === 401) {
        await notify.error('Senha incorreta. Nada foi excluído.');
      } else if (databaseCleared) {
        localStorage.clear();
        sessionStorage.clear();
        await notify.warn(
          apiMessage ||
            'O banco foi apagado, mas alguns arquivos internos não puderam ser removidos. Reinicie o aplicativo e tente novamente.',
          { title: 'Banco excluído; limpeza incompleta' }
        );
        window.location.reload();
      } else {
        await notify.error(apiMessage || 'Não foi possível concluir a exclusão total.');
      }
    } finally {
      setIsPurging(false);
    }
  };

  const cardBadgesByRoute = useMemo(() => {
    const badges = {};

    if (overview.pendentesHoje > 0) {
      badges['/notificacoes'] = {
        label: `${overview.pendentesHoje} hoje`,
        tone: 'alert',
      };
    } else if (overview.totalNotificacoes > 0) {
      badges['/notificacoes'] = {
        label: `${overview.totalNotificacoes} abertas`,
        tone: 'neutral',
      };
    }

    if (updateBadgeLabel) {
      badges['/atualizacoes'] = {
        label: updateBadgeLabel,
        tone: updateStage === 'downloaded' ? 'ok' : 'info',
      };
    }

    if (Number.isFinite(overview.emprestimos)) {
      badges['/emprestimos'] = {
        label: `${formatCompactNumber(overview.emprestimos)} ativos`,
        tone: 'neutral',
      };
    }

    return badges;
  }, [overview, updateBadgeLabel, updateStage]);

  const metricCards = useMemo(
    () => [
      {
        key: 'clientes',
        icon: 'clientes',
        label: 'Clientes ativos',
        value: formatCompactNumber(overview.clientes),
      },
      {
        key: 'emprestimos',
        icon: 'emprestimos',
        label: 'Empréstimos ativos',
        value: formatCompactNumber(overview.emprestimos),
      },
      {
        key: 'resumo_diario',
        icon: 'fluxo_caixa',
        label: 'Resumo diário',
        type: 'daily_summary',
        available: overview.backendOnline === true,
        previstoHoje: overview.resumoDiario?.previstoHoje,
        recebidoHoje: overview.resumoDiario?.recebidoHoje,
        recebidoHojeClassificado: overview.resumoDiario?.recebidoHojeClassificado,
      },
    ],
    [overview]
  );
  const versionLabel =
    appVersion && appVersion !== '-' ? `v${appVersion}` : '--';

  const renderModuleCard = (route, mode) => {
    const base = modulesByRoute.get(route);
    if (!base) return null;

    const copy = MODULE_COPY[route] || {};
    const badge = cardBadgesByRoute[route];
    const attentionClass =
      route === '/atualizacoes' && UPDATE_ATTENTION_STAGES.has(updateStage)
        ? ' dashboard-module-card--update-attention'
        : '';
    const title = copy.title || base.nome || 'Módulo';
    const description = copy.description || 'Acesse as funções deste módulo.';

    return (
      <NavLink to={base.to} key={`${mode}-${base.to}`} className={`dashboard-module-card dashboard-module-card--${mode}${attentionClass}`}>
        <span className="dashboard-module-card__icon" aria-hidden="true">
          <AppIcon name={base.icon} className="dashboard-module-card__icon-glyph" />
        </span>

        <div className="dashboard-module-card__content">
          <div className="dashboard-module-card__heading">
            <h2 className="dashboard-module-card__title">{title}</h2>
            {badge ? (
              <span className={`dashboard-badge dashboard-badge--${badge.tone}`}>
                {badge.label}
              </span>
            ) : null}
          </div>
          <p className="dashboard-module-card__description">{description}</p>
        </div>

        <span className="dashboard-module-card__cta" aria-hidden="true">
          Acessar
        </span>
      </NavLink>
    );
  };

  return (
    <section className="dashboard-page">
      <header className="dashboard-header">
        <RelatorioFinanceiroPainel />

        <div className="dashboard-metrics" role="list" aria-label="Indicadores principais">
          {metricCards.map((card) => {
            if (card.type === 'daily_summary') {
              const previsto = card.previstoHoje || { total: 0, capital: 0, juros: 0 };
              const recebido = card.recebidoHoje || { total: 0, capital: 0, juros: 0 };
              const recebidoClassificado =
                card.recebidoHojeClassificado || createRecebidoClassificadoVazio();
              const recebidoParcelasHoje = recebidoClassificado.parcelasHoje || createBucket();
              const recebidoAtrasados = recebidoClassificado.atrasados || createBucket();
              const recebidoAntecipado = recebidoClassificado.antecipado || createBucket();
              const recebidoNaoClassificado =
                recebidoClassificado.naoClassificado || createBucket();
              const temNaoClassificado =
                toSafeNumber(recebidoNaoClassificado.total) > 0.009 ||
                toSafeNumber(recebidoNaoClassificado.capital) > 0.009 ||
                toSafeNumber(recebidoNaoClassificado.juros) > 0.009;

              return (
                <article
                  key={card.key}
                  className="dashboard-metric-card dashboard-metric-card--daily"
                  role="listitem"
                >
                  <span className="dashboard-metric-card__icon" aria-hidden="true">
                    <AppIcon name={card.icon} className="dashboard-metric-card__icon-glyph" />
                  </span>

                  <div className="dashboard-metric-card__body dashboard-metric-card__body--daily">
                    <span className="dashboard-metric-card__label">{card.label}</span>

                    <button
                      type="button"
                      className="dashboard-daily-metric"
                      onClick={() =>
                        setDailyDetailsOpen((prev) => ({
                          ...prev,
                          previsto: !prev.previsto,
                        }))
                      }
                    >
                      <span className="dashboard-daily-metric__title">Hoje você deveria receber</span>
                      <strong className="dashboard-daily-metric__value">
                        {card.available ? formatCurrencyBRL(previsto.total) : '--'}
                      </strong>
                    </button>

                    {dailyDetailsOpen.previsto && card.available ? (
                      <div className="dashboard-daily-metric__details">
                        <div>Valor fixo previsto para hoje.</div>
                        <div>Capital previsto hoje: {formatCurrencyBRL(previsto.capital)}</div>
                        <div>Juros previsto hoje: {formatCurrencyBRL(previsto.juros)}</div>
                      </div>
                    ) : null}

                    <button
                      type="button"
                      className="dashboard-daily-metric"
                      onClick={() =>
                        setDailyDetailsOpen((prev) => ({
                          ...prev,
                          recebido: !prev.recebido,
                        }))
                      }
                    >
                      <span className="dashboard-daily-metric__title">Valor recebido hoje</span>
                      <strong className="dashboard-daily-metric__value">
                        {card.available ? formatCurrencyBRL(recebido.total) : '--'}
                      </strong>
                    </button>

                    {dailyDetailsOpen.recebido && card.available ? (
                      <div className="dashboard-daily-metric__details">
                        <div>
                          Recebido de parcelas de hoje: {formatCurrencyBRL(recebidoParcelasHoje.total)}
                        </div>
                        <div>
                          Capital: {formatCurrencyBRL(recebidoParcelasHoje.capital)} | Juros:{' '}
                          {formatCurrencyBRL(recebidoParcelasHoje.juros)}
                        </div>

                        <div style={{ marginTop: 6 }}>
                          Recebido de atrasados: {formatCurrencyBRL(recebidoAtrasados.total)}
                        </div>
                        <div>
                          Capital: {formatCurrencyBRL(recebidoAtrasados.capital)} | Juros:{' '}
                          {formatCurrencyBRL(recebidoAtrasados.juros)}
                        </div>

                        <div style={{ marginTop: 6 }}>
                          Recebido antecipado: {formatCurrencyBRL(recebidoAntecipado.total)}
                        </div>
                        <div>
                          Capital: {formatCurrencyBRL(recebidoAntecipado.capital)} | Juros:{' '}
                          {formatCurrencyBRL(recebidoAntecipado.juros)}
                        </div>

                        {temNaoClassificado ? (
                          <>
                            <div style={{ marginTop: 6 }}>
                              Recebido sem vencimento identificado:{' '}
                              {formatCurrencyBRL(recebidoNaoClassificado.total)}
                            </div>
                            <div>
                              Capital: {formatCurrencyBRL(recebidoNaoClassificado.capital)} | Juros:{' '}
                              {formatCurrencyBRL(recebidoNaoClassificado.juros)}
                            </div>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            }

            return (
              <article key={card.key} className="dashboard-metric-card" role="listitem">
                <span className="dashboard-metric-card__icon" aria-hidden="true">
                  <AppIcon name={card.icon} className="dashboard-metric-card__icon-glyph" />
                </span>
                <div className="dashboard-metric-card__body">
                  <strong className="dashboard-metric-card__value">{card.value}</strong>
                  <span className="dashboard-metric-card__label">{card.label}</span>
                </div>
              </article>
            );
          })}
        </div>
      </header>

      <section className="dashboard-grid dashboard-grid--main" aria-label="Módulos principais">
        {MAIN_MODULE_ORDER.map((route) => renderModuleCard(route, 'main'))}
      </section>

      <section className="dashboard-grid dashboard-grid--support" aria-label="Módulos de apoio">
        {SUPPORT_MODULE_ORDER.map((route) => renderModuleCard(route, 'support'))}
      </section>

      {SHOW_ADMIN_PURGE_ACTIONS ? (
        <section className="dashboard-danger-zone" aria-labelledby="dashboard-danger-title">
        <div className="dashboard-danger-zone__content">
          <span className="dashboard-danger-zone__eyebrow">Zona de perigo</span>
          <h2 id="dashboard-danger-title" className="dashboard-danger-zone__title">
            Excluir todos os dados
          </h2>
          <p className="dashboard-danger-zone__description">
            Apaga todo o banco, históricos, backups internos, uploads e dados armazenados pelo sistema.
          </p>
        </div>
        <button
          type="button"
          className="dashboard-danger-zone__button"
          onClick={handlePurgeAll}
          disabled={isPurging}
        >
          {isPurging ? 'Excluindo tudo...' : 'Excluir tudo permanentemente'}
        </button>
        </section>
      ) : null}

      <footer className="dashboard-status-strip" aria-label="Status do sistema">
        <article className="dashboard-status-item">
          <strong className="dashboard-status-item__title">Status do sistema</strong>
          <span className="dashboard-status-item__value">
            <span
              className={`dashboard-status-dot ${
                overview.backendOnline == null
                  ? 'is-waiting'
                  : overview.backendOnline
                    ? 'is-ok'
                    : 'is-error'
              }`}
              aria-hidden="true"
            />
            {overview.backendOnline == null
              ? 'Verificando conectividade...'
              : overview.backendOnline
                ? 'Serviços respondendo normalmente.'
                : 'Falha de comunicação com backend.'}
          </span>
        </article>

        <article className="dashboard-status-item">
          <strong className="dashboard-status-item__title">Último backup</strong>
          <span className="dashboard-status-item__value">
            {formatDateTime(overview.ultimoBackupEm)}
          </span>
        </article>

        <article className="dashboard-status-item">
          <strong className="dashboard-status-item__title">Última sincronização</strong>
          <span className="dashboard-status-item__value">{formatDateTime(lastSyncAt)}</span>
        </article>

        <article className="dashboard-status-item">
          <strong className="dashboard-status-item__title">Versão do sistema</strong>
          <span className="dashboard-status-item__value">{versionLabel}</span>
        </article>
      </footer>
    </section>
  );
}
