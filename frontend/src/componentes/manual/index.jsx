import React, { useState } from 'react';
import useManualLogic from './useManualLogic';
import ResumoPagamento from './ResumoPagamento';
import FormRenegociacao from './FormRenegociacao';
import PreviewParcelas from './PreviewParcelas';

export default function Manual(props) {
  const [resumoAberto, setResumoAberto] = useState(false);
  const {
    valorTotal,
    emprestimo,
    clienteNome,
    inputStyle,
    labelMutedStyle,
    getCodigoEmprestimo,
    isJurosParcialPreview,
    primeiraAberta,
    saldoJurosParcela,
    valorTotalParcela,
    capitalParcela,
    capitalAnterior,
    capitalPosParcela,
    sobraAposParcela,
    abatExtraCapital,
    novoCapitalCalculado,
    usadoPrimeiraJ,
    usadoPrimeiraC,
    BRL,
    novoValorStr,
    handleNovoCapitalChange,
    novoParcelas,
    setNovoParcelas,
    novoTaxa,
    setNovoTaxa,
    novoObs,
    setNovoObs,
    novoVencimento,
    setNovoVencimento,
    previewRenegociacao,
    // continua disponível se quiser usar depois:
    registrarHabilitado,
    distribuido,
    handleRegistrar,
    // NOVO: pré-visualização específica para juros parcial
    previewJurosParcial,
  } = useManualLogic(props);

  const { onClose } = props;

  if (!emprestimo) {
    return (
      <div
        className="border rounded-xl p-4"
        style={{
          border: '1px solid var(--border-soft)',
          background: 'var(--bg-card)',
          color: 'var(--text-main)',
        }}
      >
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Carregando pagamento manual…
        </div>
      </div>
    );
  }

  return (
    <div
      className="border rounded-xl p-5"
      style={{
        maxWidth: 560,
        margin: '0 auto',
        border: '1px solid var(--border-soft)',
        background: 'var(--bg-card)',
        color: 'var(--text-main)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <h3 className="text-xl font-bold" style={{ margin: 0, color: 'var(--text-main)' }}>
          Renegociação
        </h3>
        {valorTotal > 0 && primeiraAberta ? (
          <button
            type="button"
            onClick={() => setResumoAberto((aberto) => !aberto)}
            aria-expanded={resumoAberto}
            aria-controls="resumo-pagamento-manual"
            title={resumoAberto ? 'Minimizar resumo do pagamento' : 'Mostrar resumo do pagamento'}
            style={{
              width: 30,
              height: 30,
              padding: 0,
              borderRadius: 7,
              border: '1px solid var(--border-soft)',
              background: 'var(--bg-card)',
              color: 'var(--text-main)',
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center',
              fontSize: 21,
              lineHeight: 1,
            }}
          >
            {resumoAberto ? '−' : '+'}
          </button>
        ) : null}
      </div>

      {resumoAberto && valorTotal > 0 && primeiraAberta && (
        <div
          id="resumo-pagamento-manual"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-soft)',
            borderRadius: 10,
            padding: '14px 16px',
            fontSize: 14,
            color: 'var(--text-main)',
            marginBottom: 18,
            lineHeight: 1.7,
          }}
        >
          <div
            style={{
              fontWeight: 700,
              marginBottom: 6,
              color: 'var(--text-main)',
            }}
          >
            Resumo do pagamento
          </div>

          <ResumoPagamento
            valorTotal={valorTotal}
            primeiraAberta={primeiraAberta}
            saldoJurosParcela={saldoJurosParcela}
            valorTotalParcela={valorTotalParcela}
            capitalParcela={capitalParcela}
            capitalAnterior={capitalAnterior}
            capitalPosParcela={capitalPosParcela}
            sobraAposParcela={sobraAposParcela}
            abatExtraCapital={abatExtraCapital}
            novoCapitalCalculado={novoCapitalCalculado}
            isJurosParcialPreview={isJurosParcialPreview}
            usadoPrimeiraJ={usadoPrimeiraJ}
            usadoPrimeiraC={usadoPrimeiraC}
            BRL={BRL}
          />
        </div>
      )}

      <div className="grid grid-cols-1" style={{ rowGap: 14 }}>
        <FormRenegociacao
          clienteNome={clienteNome}
          emprestimo={emprestimo}
          getCodigoEmprestimo={getCodigoEmprestimo}
          inputStyle={inputStyle}
          labelMutedStyle={labelMutedStyle}
          isJurosParcialPreview={isJurosParcialPreview}
          novoValorStr={novoValorStr}
          handleNovoCapitalChange={handleNovoCapitalChange}
          novoCapitalCalculado={novoCapitalCalculado}
          BRL={BRL}
          novoParcelas={novoParcelas}
          setNovoParcelas={setNovoParcelas}
          novoTaxa={novoTaxa}
          setNovoTaxa={setNovoTaxa}
          novoObs={novoObs}
          setNovoObs={setNovoObs}
          novoVencimento={novoVencimento}
          setNovoVencimento={setNovoVencimento}
        />
      </div>

      {/* Agora o PreviewParcelas aparece SEMPRE,
          trocando de modo quando for juros parcial */}
      <PreviewParcelas
        previewRenegociacao={previewRenegociacao}
        BRL={BRL}
        modoJurosParcial={isJurosParcialPreview}
        previewJurosParcial={previewJurosParcial}
      />

      <div
        className="manual-modal-actions"
        style={{
          marginTop: 18,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
        }}
      >
        <button
          className="px-4 py-2 rounded-md border hover:bg-gray-100 cancelar"
          style={{
            border: '1px solid var(--border-soft)',
            color: 'var(--text-main)',
          }}
          onClick={() => onClose && onClose(null)}
        >
          Cancelar
        </button>
        <button
          className={`px-5 py-2 rounded-md font-medium ${
            distribuido > 0
              ? 'bg-gray-900 text-white hover:bg-black'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }`}
          disabled={distribuido <= 0}
          onClick={handleRegistrar}
        >
          Registrar
        </button>
      </div>
    </div>
  );
}
