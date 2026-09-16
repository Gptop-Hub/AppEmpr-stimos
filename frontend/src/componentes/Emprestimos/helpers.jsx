import React from "react";

export const mesesNome = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

export const pad = (n) => String(n).padStart(2, "0");

export const formatarMoeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const getTotalDevidoParcela = (parcela = {}) => {
  const baseTotal = toNum(parcela.valor_total);
  const adic = toNum(parcela.juros_adicionais);
  if (baseTotal > 0 || adic > 0) return baseTotal + adic;

  const capital = toNum(parcela.valor_capital);
  const jurosBase = toNum(parcela.valor_juros);
  const pend = toNum(parcela.juros_pendentes);
  return capital + jurosBase + pend + adic;
};

export const renderLinhaJuros = (parcela = {}, formatFn = formatarMoeda, opts = {}) => {
  const fmt = typeof formatFn === "function" ? formatFn : formatarMoeda;
  const capital = fmt(toNum(parcela.valor_capital));
  const jurosBase = fmt(toNum(parcela.valor_juros));
  const jurosPendentesRaw = toNum(parcela.juros_pendentes);
  const jurosPendentes = jurosPendentesRaw > 0 ? fmt(jurosPendentesRaw) : null;
  const jurosAdicionais = fmt(toNum(parcela.juros_adicionais));
  const renderAdic = opts.renderJurosAdicionais;
  const renderPend = opts.renderJurosPendentes;

  return (
    <>
      Capital: <strong>{capital}</strong>{" | "}
      Juros: <strong>{jurosBase}</strong>
      {jurosPendentes ? (
        <>
          {" + "}
          {renderPend ? renderPend(jurosPendentes) : <strong>{jurosPendentes}</strong>}
        </>
      ) : null}
      {" | "}
      {renderAdic ? (
        renderAdic(jurosAdicionais)
      ) : (
        <>
          Juros Adicionais: <strong>{jurosAdicionais}</strong>
        </>
      )}
    </>
  );
};

export const toDateObj = (d) => {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (iso) {
    const [y, m, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const dt = new Date(y, m - 1, day);
    return isNaN(dt.getTime()) ? null : dt;
  }
  if (typeof d === "string" && d.includes("/")) {
    const parts = d.split("/");
    if (parts.length === 3) {
      const [day, mon, year] = parts.map((x) => Number(x));
      const dt = new Date(year, mon - 1, day);
      return isNaN(dt.getTime()) ? null : dt;
    }
  }
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? null : dt;
};

export const normalizarDetalhesReneg = (detalhes) => {
  if (!detalhes) return null;
  if (typeof detalhes === "object") return detalhes;
  if (typeof detalhes === "string") {
    try {
      return JSON.parse(detalhes);
    } catch {
      return null;
    }
  }
  return null;
};

export const extrairValorAdicionar = (detalhes) => {
  const det = normalizarDetalhesReneg(detalhes);
  if (!det) return null;
  const raw =
    det.valor_adicionar ?? det.valor_adicionado ?? det.valorAdicionar ?? null;
  if (raw == null) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
};

export const obterComposicaoValorEmprestado = (emp) => {
  const historicos = Array.isArray(emp?.renegociacoesHistorico)
    ? emp.renegociacoesHistorico
    : [];

  const historicosAdd = historicos.filter((h) => {
    const det = normalizarDetalhesReneg(h?.detalhes);
    const temValor =
      det &&
      (det.valor_adicionar != null ||
        det.valor_adicionado != null ||
        det.valorAdicionar != null);
    const tipo = String(h?.tipo || "").toLowerCase();
    return tipo === "adicionar_capital" || temValor;
  });

  const addicoes = historicosAdd
    .map((h) => extrairValorAdicionar(h?.detalhes))
    .filter((v) => Number.isFinite(v) && v > 0);

  const primeiroAdd = historicosAdd.length ? historicosAdd[0] : null;
  const snap = primeiroAdd?.snapshot_emprestimo || null;
  const baseSnap =
    snap?.valor_emprestado ??
    snap?.valor_original ??
    snap?.valor_inicial ??
    snap?.valor_atual ??
    snap?.valor ??
    null;

  let base = Number(baseSnap);
  if (!Number.isFinite(base) || base <= 0) {
    const baseEmp =
      emp?.valor_emprestado ??
      emp?.valor_original ??
      emp?.valor_inicial ??
      emp?.valor_atual ??
      emp?.valor ??
      0;
    base = Number(baseEmp);
    if (Number.isFinite(base) && addicoes.length > 0) {
      const somaAdd = addicoes.reduce((s, v) => s + v, 0);
      if (base - somaAdd > 0) {
        base = base - somaAdd;
      }
    }
  }

  const composicao = [base, ...addicoes].filter(
    (v) => Number.isFinite(v) && v > 0
  );

  return composicao;
};

export const formatarData = (d) => {
  const dt = toDateObj(d);
  if (!dt) return "-";
  return `${pad(dt.getDate())} ${mesesNome[dt.getMonth()]} ${dt.getFullYear()}`;
};

export const dataParaInput = (d) => {
  const dt = toDateObj(d);
  if (!dt) return "";
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
};

export const addMonthsAdjust = (date, months) => {
  const base = date instanceof Date ? new Date(date.getTime()) : toDateObj(date);
  if (!base || isNaN(base.getTime())) return null;
  const targetMonth = base.getMonth() + months;
  const y = base.getFullYear() + Math.floor(targetMonth / 12);
  const m = ((targetMonth % 12) + 12) % 12;
  const day = base.getDate();
  const lastDay = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, lastDay));
};

export const formatarDataCurta = (d) => {
  const dt = toDateObj(d);
  if (!dt) return "";
  return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}`;
};

export const calcularPreviewParcelas = ({
  total,
  parcelas,
  taxaPercent,
  primeiroVencimento,
  placeholderVencimento = "dd mm aaaa",
}) => {
  const totalNum = Number(total);
  const m = parseInt(parcelas || "0", 10);
  const taxaNum = Number(taxaPercent);

  if (!m || m <= 0 || !Number.isFinite(totalNum) || totalNum <= 0) return [];

  const taxa = Number.isFinite(taxaNum) ? taxaNum / 100 : 0;
  let saldo = totalNum;
  const preview = [];

  const firstDue = primeiroVencimento ? toDateObj(primeiroVencimento) : null;

  for (let i = 1; i <= m; i++) {
    const amort = totalNum / m;
    const jurosVal = saldo * taxa;
    const valorParc = amort + jurosVal;

    let vencFormatado = placeholderVencimento;
    if (firstDue) {
      const venc = i === 1 ? firstDue : addMonthsAdjust(firstDue, i - 1);
      vencFormatado = formatarDataCurta(venc);
    }

    preview.push({
      numero: i,
      amortizacao: isNaN(amort) ? 0 : amort,
      juros: isNaN(jurosVal) ? 0 : jurosVal,
      total: isNaN(valorParc) ? 0 : valorParc,
      vencimento: vencFormatado,
    });

    saldo -= amort;
  }

  return preview;
};

export const calcularTempoPassado = (dataInicio) => {
  const inicio = toDateObj(dataInicio);
  if (!inicio) return "-";
  const hoje = new Date();
  let months =
    (hoje.getFullYear() - inicio.getFullYear()) * 12 +
    (hoje.getMonth() - inicio.getMonth());
  const anchor = new Date(
    inicio.getFullYear(),
    inicio.getMonth() + months,
    inicio.getDate()
  );
  if (anchor > hoje) months -= 1;
  const anchorAdj = new Date(
    inicio.getFullYear(),
    inicio.getMonth() + months,
    inicio.getDate()
  );
  const days = Math.floor(
    (hoje - anchorAdj) / (1000 * 60 * 60 * 24)
  );
  if (months <= 0)
    return days <= 0 ? "0 dias" : `${days} ${days === 1 ? "dia" : "dias"}`;
  return `${months} ${
    months === 1 ? "mês" : "meses"
  }${days > 0 ? `, ${days} ${days === 1 ? "dia" : "dias"}` : ""}`;
};

const monthAlternatives = mesesNome.join("|");

export const renderHighlightedText = (text, opts = {}) => {
  const boldCurrency = opts.boldCurrency !== false;
  const currencyWeight =
    typeof opts.currencyWeight === "number" ? opts.currencyWeight : 800;
  if (!text) return null;
  const original = String(text);
  const dateSlashRe = /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g;
  const dateWordRe = new RegExp(
    `\\b\\d{1,2}\\s+(?:${monthAlternatives})\\s+\\d{4}\\b`,
    "gi"
  );
  const parcelaRe = /\bparcela(?:s)?\s*\d+\b/gi;
  const currencyRe =
    /R\$\s?\d{1,3}(?:[\.\d]{0,})?(?:[.,]\d{2})?/g;

  const all = [];
  const push = (re, type) => {
    let m;
    while ((m = re.exec(original)) !== null)
      all.push({
        i: m.index,
        len: m[0].length,
        text: m[0],
        type,
      });
  };
  push(dateSlashRe, "dateSlash");
  push(dateWordRe, "dateWord");
  push(parcelaRe, "parcela");
  push(currencyRe, "currency");
  if (!all.length) return original;

  all.sort((a, b) => a.i - b.i || b.len - a.len);
  const nonOverlap = [];
  let last = -1;
  for (const m of all)
    if (m.i >= last) {
      nonOverlap.push(m);
      last = m.i + m.len;
    }

  const nodes = [];
  let cur = 0;
  let k = 0;
  for (const m of nonOverlap) {
    if (m.i > cur)
      nodes.push(
        <span key={`t${k++}`}>{original.slice(cur, m.i)}</span>
      );
    let rendered = m.text;
    if (m.type === "dateSlash") {
      const dt = toDateObj(m.text);
      rendered = dt ? formatarData(dt) : m.text;
    } else if (m.type === "dateWord") rendered = m.text;
      if (m.type === "currency" && !boldCurrency) {
        nodes.push(<span key={`h${k++}`}>{rendered}</span>);
      } else {
        const strongStyle =
          m.type === "currency" ? { fontWeight: currencyWeight } : undefined;
        nodes.push(
          <strong key={`h${k++}`} style={strongStyle}>
            {rendered}
          </strong>
        );
      }
    cur = m.i + m.len;
  }
  if (cur < original.length)
    nodes.push(
      <span key={`t${k++}`}>{original.slice(cur)}</span>
    );
  return nodes;
};

export const getExpLineType = (line) => {
  if (!line) return "other";
  const t = String(line).trim().toLowerCase();
  if (t.startsWith("➡") || t.startsWith("->") || t.includes("vencimento"))
    return "venc";
  if (
    t.startsWith("📌") ||
    t.startsWith("no dia") ||
    t.includes("foram pagos")
  )
    return "note";
  return "other";
};

export const isParcelFantasma = (p) => {
  if (!p) return false;
  try {
    const exp = String(p.explicacao || "").trim();
    return exp.toUpperCase().startsWith("PARCELA FANTASMA");
  } catch {
    return false;
  }
};

export const isParcelQuitadaMensagem = (p) => {
  if (!p) return false;
  try {
    const exp = String(p.explicacao || "").trim();
    return exp.toUpperCase().startsWith("EMPRESTIMO QUITADO");
  } catch {
    return false;
  }
};

export const extractQuitAmountFromExplicacao = (p) => {
  try {
    const txt = String(p.explicacao || "");
    const m =
      /R\$\s?[\d\.]+(?:[,\.]\d{2})?/.exec(txt);
  if (!m) return null;
    const numStr = m[0]
      .replace(/R\$|\s|\./g, "")
      .replace(",", ".");
    const num = Number(numStr);
    return isNaN(num) ? null : num;
  } catch {
    return null;
  }
};

export const extractDateFromExplicacao = (text) => {
  if (!text) return null;
  let m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(String(text));
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]) - 1;
    const yy = Number(m[3]);
    const dt = new Date(yy, mm, dd);
    return isNaN(dt.getTime()) ? null : dt;
  }
  m = /(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})/.exec(
    String(text)
  );
  if (m) {
    const dd = Number(m[1]);
    const monthName = m[2];
    const yy = Number(m[3]);
    const mi = mesesNome.findIndex(
      (x) => x.toLowerCase() === monthName.toLowerCase()
    );
    if (mi >= 0) {
      const dt = new Date(yy, mi, dd);
      return isNaN(dt.getTime()) ? null : dt;
    }
  }
  return null;
};

export const tipoLabel = (tipo) => {
  if (!tipo) return "";
  if (tipo === "normal") return "comum";
  if (tipo === "juros") return "juros";
  if (tipo === "manual") return "manual";
  if (tipo === "desconto_proxima")
    return "desconto na próxima";
  return tipo;
};

export const parseObservacoes = (p = {}) => {
  const out = [];

  if (Array.isArray(p.observacoes) && p.observacoes.length > 0) {
    for (const item of p.observacoes) {
      if (!item) continue;
      if (typeof item === "string") {
        out.push({
          texto: item,
          tipo: p.tipo_pagamento || null,
          data: p.data_pagamento || null,
        });
      } else if (typeof item === "object") {
        const texto =
          item.texto ||
          item.observacao ||
          item.obs ||
          item.note ||
          "";
        const tipo =
          item.tipo ||
          item.tipo_pagamento ||
          item.paymentType ||
          null;
        const data =
          item.data ||
          item.data_pagamento ||
          item.date ||
          null;
        if (texto) out.push({ texto, tipo, data });
      }
    }
    return out;
  }

  if (p.observacao) {
    const lines = String(p.observacao)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      let texto = line;
      let tipo = null;
      let dataIso = null;

      const parts = line.split(/\s*—\s*/);
      if (parts.length > 1) {
        texto = parts[0].trim();
        const suffix = parts.slice(1).join(" — ").trim();
        const suffixParts = suffix
          .split("·")
          .map((s) => s.trim());
        if (suffixParts[0]) tipo = suffixParts[0];
        if (suffixParts[1]) {
          const s2 = suffixParts[1];
          const mSlash =
            /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s2);
          if (mSlash) {
            const dd = Number(mSlash[1]);
            const mm = Number(mSlash[2]) - 1;
            const yy = Number(mSlash[3]);
            const dt = new Date(yy, mm, dd);
            if (!isNaN(dt.getTime()))
              dataIso = dt.toISOString();
          } else {
            const re2 =
              /^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})$/;
            const m2 = re2.exec(s2);
            if (m2) {
              const dd = Number(m2[1]);
              const monthName = m2[2];
              const yy = Number(m2[3]);
              const monthIndex = mesesNome.findIndex(
                (x) =>
                  x.toLowerCase() ===
                  monthName.toLowerCase()
              );
              if (monthIndex >= 0) {
                const dt = new Date(yy, monthIndex, dd);
                if (!isNaN(dt.getTime()))
                  dataIso = dt.toISOString();
              }
            }
          }
        }
      }

      out.push({ texto, tipo, data: dataIso });
    }
  }

  return out;
};

// 🔧 Máscara para histórico: cola todos os valores pagos
// em uma única parcela alvo (a de menor número),
// usada apenas na visão de renegociação (showAntigas = true)
// 🔧 Máscara para histórico (DESATIVADA):
// Antes colava todos os valores pagos em uma parcela só.
// Agora não altera nada, apenas devolve o mesmo array.
export const mascararPagamentosHistorico = (parcelas = []) => {
  return Array.isArray(parcelas) ? parcelas : [];
};
