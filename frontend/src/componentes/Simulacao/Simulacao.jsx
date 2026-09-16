import React, { useMemo, useState } from 'react';
import notify from '../../ui/notify';
import { toNumber, formatarMoeda } from './moeda';
import { gerarParcelasSimulacao } from './gerarParcelasSimulacao';
import ResultadoTabela from './ResultadoTabela';
import StepperInput from '../common/StepperInput.jsx';
import './Simulacao.css';

const initialForm = {
  valor: '',
  parcelas: '',
  juros: '10',
};

const sanitizeDecimalInput = (value, maxDecimals = 2) => {
  const clean = String(value || '').replace(/[^\d.,]/g, '');
  let out = '';
  let hasSep = false;

  for (const ch of clean) {
    if (/\d/.test(ch)) {
      out += ch;
      continue;
    }
    if (!hasSep) {
      out += ',';
      hasSep = true;
    }
  }

  if (!hasSep) return out;
  const [intPart, decPartRaw = ''] = out.split(',');
  const decPart = decPartRaw.slice(0, Math.max(0, maxDecimals));
  return `${intPart},${decPart}`;
};

const formatCurrencyInput = (value) => {
  const raw = String(value || '');
  const only = raw.replace(/[^\d,]/g, '');
  if (!only) return '';

  const hasComma = only.includes(',');
  const commaIndex = only.indexOf(',');
  const intRaw = hasComma ? only.slice(0, commaIndex) : only;
  const decRaw = hasComma ? only.slice(commaIndex + 1).replace(/,/g, '') : '';

  const intClean = intRaw.replace(/^0+(?=\d)/, '');
  const intNormalized = intClean || '0';
  const intFormatted = intNormalized.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  if (hasComma) {
    return `${intFormatted},${decRaw.slice(0, 2)}`;
  }
  return intFormatted;
};

function copiarTexto(texto) {
  if (!texto) return Promise.reject(new Error('Nada para copiar.'));

  if (navigator?.clipboard?.writeText) {
    return navigator.clipboard.writeText(texto);
  }

  const el = document.createElement('textarea');
  el.value = texto;
  el.setAttribute('readonly', '');
  el.style.position = 'absolute';
  el.style.left = '-9999px';
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
  return Promise.resolve();
}

export default function Simulacao() {
  const [form, setForm] = useState(initialForm);

  const parcelas = useMemo(() => {
    const capital = toNumber(form.valor);
    const qtdParcelas = Math.trunc(toNumber(form.parcelas));
    const jurosRaw = String(form.juros || '').trim();
    const taxa_juros = jurosRaw === '' ? 0 : toNumber(form.juros);

    if (!capital || capital <= 0) return [];
    if (!qtdParcelas || qtdParcelas <= 0) return [];
    if (taxa_juros < 0) return [];

    return gerarParcelasSimulacao({
      capital,
      taxa_juros,
      qtdParcelas,
    });
  }, [form.valor, form.parcelas, form.juros]);

  const resumo = useMemo(() => {
    const total = parcelas.reduce((acc, p) => acc + Number(p.valor_total || 0), 0);
    const capital = parcelas.reduce((acc, p) => acc + Number(p.valor_capital || 0), 0);
    const juros = parcelas.reduce((acc, p) => acc + Number(p.valor_juros || 0), 0);
    return { total, capital, juros };
  }, [parcelas]);

  const onValorChange = (e) => {
    setForm((prev) => ({
      ...prev,
      valor: formatCurrencyInput(e.target.value),
    }));
  };

  const onJurosChange = (e) => {
    setForm((prev) => ({
      ...prev,
      juros: sanitizeDecimalInput(e.target.value, 4),
    }));
  };

  const resetar = () => {
    setForm(initialForm);
  };

  const copiar = async () => {
    if (!parcelas.length) {
      notify.warn('Gere uma simulacao antes de copiar.');
      return;
    }

    const capital = toNumber(form.valor);
    const qtdParcelas = Math.trunc(toNumber(form.parcelas));
    const moeda = (v) => formatarMoeda(v).replace(/\u00A0/g, ' ');
    const cabecalho = `Valor: ${moeda(capital)} x ${qtdParcelas} Parcelas`;
    const linhas = parcelas.map((p) => `${p.numero}\u00B0 ${moeda(p.valor_total)}`);

    try {
      await copiarTexto([cabecalho, '', ...linhas].join('\n'));
      notify.success('Simulacao copiada.');
    } catch {
      notify.error('Nao foi possivel copiar os dados.');
    }
  };

  const copiarDetalhado = async () => {
    if (!parcelas.length) {
      notify.warn('Gere uma simulacao antes de copiar.');
      return;
    }

    const capital = toNumber(form.valor);
    const qtdParcelas = Math.trunc(toNumber(form.parcelas));
    const moeda = (v) => formatarMoeda(v).replace(/\u00A0/g, ' ');

    const linhas = parcelas.map(
      (p) =>
        `${p.numero}\u00AA: ${moeda(p.valor_total)}\n(Capital: ${moeda(
          p.valor_capital
        )}, Juros: ${moeda(p.valor_juros)})`
    );

    const texto = [
      `Valor: ${moeda(capital)} | Parcelas: ${qtdParcelas}`,
      '',
      '',
      linhas.join('\n\n'),
    ].join('\n');

    try {
      await copiarTexto(texto);
      notify.success('Simulacao detalhada copiada.');
    } catch {
      notify.error('Nao foi possivel copiar os dados detalhados.');
    }
  };

  return (
    <div className="simulacao-page">
      <div className="simulacao-layout">
        <section className="simulacao-col simulacao-col--form">
          <div className="simulacao-card">
            <label className="simulacao-label">
              {'Valor (R$)'}
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={form.valor}
                onChange={onValorChange}
                placeholder="R$ 0,00"
                className="simulacao-input"
              />
            </label>

            <label className="simulacao-label">
              {'Parcelas'}
              <StepperInput
                value={form.parcelas}
                onChange={(next) =>
                  setForm((prev) => ({
                    ...prev,
                    parcelas: String(next),
                  }))
                }
                min={0}
                inputAriaLabel="Quantidade de parcelas na simulacao"
                className="simulacao-stepper"
              />
            </label>

            <label className="simulacao-label">
              {'Juros (%)'}
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={form.juros}
                onChange={onJurosChange}
                placeholder="10"
                className="simulacao-input"
              />
            </label>

            <button type="button" onClick={copiar} className="simulacao-btn">
              {'Copiar Simples'}
            </button>
            <button
              type="button"
              onClick={copiarDetalhado}
              className="simulacao-btn"
            >
              {'Copiar Detalhado'}
            </button>
            <button type="button" onClick={resetar} className="simulacao-btn">
              {'Limpar'}
            </button>
          </div>
        </section>

        <section className="simulacao-col simulacao-col--resultado">
          <ResultadoTabela parcelas={parcelas} />

          {parcelas.length > 0 ? (
            <div className="simulacao-resumo">
              <span>
                <strong>{'Total pago:'}</strong> {formatarMoeda(resumo.total)}
              </span>
              <span>
                <strong>{'Total capital:'}</strong> {formatarMoeda(resumo.capital)}
              </span>
              <span>
                <strong>{'Total juros:'}</strong> {formatarMoeda(resumo.juros)}
              </span>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
