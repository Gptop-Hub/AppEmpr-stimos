import React from 'react';
import StepperInput from '../common/StepperInput.jsx';
import ClienteIdentity from '../common/ClienteIdentity.jsx';
import useClientesCatalogo from '../common/useClientesCatalogo.js';

export default function FormRenegociacao({
  clienteNome,
  emprestimo,
  getCodigoEmprestimo,
  inputStyle,
  labelMutedStyle,
  isJurosParcialPreview,
  novoValorStr,
  handleNovoCapitalChange,
  novoCapitalCalculado,
  BRL,
  novoParcelas,
  setNovoParcelas,
  novoTaxa,
  setNovoTaxa,
  novoObs,
  setNovoObs,
  novoVencimento,
  setNovoVencimento,
}) {
  const { resolverCliente } = useClientesCatalogo();
  return (
    <>
      <div style={{ marginBottom: 6 }}>
        <div className="text-xs mb-1" style={labelMutedStyle}>
          Cliente (fixo)
        </div>
        <div className="cliente-selection-preview">
          <ClienteIdentity
            cliente={resolverCliente(emprestimo?.cliente_id, clienteNome)}
            avatarSize={40}
            secondary={`Empréstimo #${getCodigoEmprestimo(emprestimo)}`}
          />
        </div>
      </div>

      {/* Esses campos somem no modo juros parcial */}
      {!isJurosParcialPreview && (
        <>
          <div style={{ marginBottom: 4 }}>
            <div className="text-xs mb-1" style={labelMutedStyle}>
              Novo capital (R$)
            </div>
            <input
              type="text"
              inputMode="numeric"
              value={novoValorStr}
              onChange={handleNovoCapitalChange}
              className="w-full border rounded-md px-3 py-2"
              style={inputStyle}
              placeholder="R$ 0,00"
            />
            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                color: 'var(--text-muted)',
              }}
            >
              Sugestão (pelo cálculo acima):{' '}
              <strong>{BRL(novoCapitalCalculado)}</strong>
            </div>
          </div>

          <div>
            <div className="text-xs mb-1" style={labelMutedStyle}>
              Parcelas
            </div>
            <StepperInput
              value={novoParcelas}
              onChange={setNovoParcelas}
              min={1}
              inputAriaLabel="Quantidade de parcelas"
              style={{ width: '100%' }}
            />
          </div>

          <div>
            <div className="text-xs mb-1" style={labelMutedStyle}>
              Taxa de Juros (%)
            </div>
            <input
              type="text"
              value={novoTaxa}
              onChange={(e) =>
                setNovoTaxa(e.target.value.replace(/[^0-9.,]/g, ''))
              }
              className="w-full border rounded-md px-3 py-2"
              style={inputStyle}
            />
          </div>

          <div>
            <div className="text-xs mb-1" style={labelMutedStyle}>
              Observação do empréstimo
            </div>
            <input
              type="text"
              value={novoObs}
              onChange={(e) => setNovoObs(e.target.value)}
              className="w-full border rounded-md px-3 py-2"
              style={inputStyle}
              placeholder="(opcional)"
            />
          </div>
        </>
      )}

      {isJurosParcialPreview ? (
        <div>
          <div className="text-xs mb-1" style={labelMutedStyle}>
            Próximo vencimento
          </div>
          <input
            type="date"
            value={novoVencimento}
            onChange={(e) => setNovoVencimento(e.target.value)}
            required
            className="w-full border rounded-md px-3 py-2"
            style={inputStyle}
          />
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            Confirme ou edite a data da próxima cobrança antes de registrar.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs mb-1" style={labelMutedStyle}>
              Data de início (original)
            </div>
            <input
              type="date"
              value={(emprestimo.data || '').slice(0, 10)}
              readOnly
              className="w-full border rounded-md px-3 py-2"
              style={inputStyle}
            />
          </div>

          <div>
            <div className="text-xs mb-1" style={labelMutedStyle}>
              1º Vencimento
            </div>
            <input
              type="date"
              value={novoVencimento}
              onChange={(e) => setNovoVencimento(e.target.value)}
              className="w-full border rounded-md px-3 py-2"
              style={inputStyle}
            />
          </div>
        </div>
      )}
    </>
  );
}
