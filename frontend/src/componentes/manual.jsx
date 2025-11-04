import React, { useState, useEffect } from 'react';
import axios from 'axios';
import notify from '../ui/notify';

export default function Manual({ emprestimoId, valorPagamento, onClose }) {
  const [parcelas, setParcelas] = useState([]);
  const [saldoRestante, setSaldoRestante] = useState(Number(valorPagamento || 0));
  const [registrarHabilitado, setRegistrarHabilitado] = useState(false);

  useEffect(() => {
    async function fetchParcelas() {
      try {
        const res = await axios.get(`/parcelas/${emprestimoId}`);
        const p = res.data.map(p => ({
          ...p,
          abatidoCapital: 0,
          abatidoJuros: 0,
          abatidoTotal: 0
        }));
        setParcelas(p);
      } catch (err) {
        console.error('[ERRO] Fetch parcelas:', err);
      }
    }
    fetchParcelas();
  }, [emprestimoId]);

  const handleAbater = async (index, tipo) => {
    const parcela = parcelas[index];
    if (saldoRestante <= 0) return;

    let maxAbater = 0;
    if (tipo === 'total') maxAbater = parcela.valor_total - parcela.abatidoTotal;
    else if (tipo === 'capital') maxAbater = parcela.valor_capital - parcela.abatidoCapital;
    else if (tipo === 'juros') maxAbater = parcela.valor_juros - parcela.abatidoJuros;

    if (maxAbater <= 0) {
      notify.warn('Nada disponivel para abater nesta opcao.');
      return;
    }

    const valorEntrada = await notify.prompt(
      `Quanto deseja abater de ${tipo}? (max: ${maxAbater.toFixed(2)})`,
      {
        type: 'number',
        defaultValue: maxAbater.toFixed(2),
        okText: 'Aplicar',
        cancelText: 'Cancelar',
      }
    );
    if (valorEntrada === null || valorEntrada === '') return;

    const normalizado = String(valorEntrada).replace(',', '.');
    let valorNum = parseFloat(normalizado);
    if (Number.isNaN(valorNum) || valorNum <= 0) {
      notify.warn('Informe um valor numerico valido.');
      return;
    }
    valorNum = Math.min(valorNum, saldoRestante, maxAbater);

    const novasParcelas = [...parcelas];
    const restanteTotalAntes = parcela.valor_total - parcela.abatidoTotal;

    if (tipo === 'total') {
      novasParcelas[index].abatidoTotal += valorNum;
      if (restanteTotalAntes > 0) {
        const restanteCap = parcela.valor_capital - parcela.abatidoCapital;
        const restanteJur = parcela.valor_juros - parcela.abatidoJuros;
        const proporcaoCapital = restanteCap / restanteTotalAntes;
        const proporcaoJuros = restanteJur / restanteTotalAntes;
        novasParcelas[index].abatidoCapital += valorNum * (isFinite(proporcaoCapital) ? proporcaoCapital : 0);
        novasParcelas[index].abatidoJuros += valorNum * (isFinite(proporcaoJuros) ? proporcaoJuros : 0);
      } else {
        novasParcelas[index].abatidoCapital += valorNum;
      }
    } else if (tipo === 'capital') {
      novasParcelas[index].abatidoCapital += valorNum;
      novasParcelas[index].abatidoTotal += valorNum;
    } else if (tipo === 'juros') {
      novasParcelas[index].abatidoJuros += valorNum;
      novasParcelas[index].abatidoTotal += valorNum;
    }

    novasParcelas[index].abatidoCapital = Number(novasParcelas[index].abatidoCapital.toFixed(2));
    novasParcelas[index].abatidoJuros = Number(novasParcelas[index].abatidoJuros.toFixed(2));
    novasParcelas[index].abatidoTotal = Number(novasParcelas[index].abatidoTotal.toFixed(2));

    setParcelas(novasParcelas);
    const novoSaldo = Number((saldoRestante - valorNum).toFixed(2));
    setSaldoRestante(novoSaldo);
    if (novoSaldo <= 0) setRegistrarHabilitado(true);
  };

  const handleRegistrar = async () => {
    try {
      const abatimentos = parcelas
        .filter(p => p.abatidoTotal > 0)
        .map(p => ({
          parcelaId: p.id,
          abatidoCapital: parseFloat(p.abatidoCapital.toFixed(2)),
          abatidoJuros: parseFloat(p.abatidoJuros.toFixed(2)),
          abatidoTotal: parseFloat(p.abatidoTotal.toFixed(2))
        }));

      if (abatimentos.length === 0) {
        notify.warn('Nenhum abatimento selecionado.');
        return;
      }

      const res = await axios.post('/pagamentos/manual', {
        emprestimoId,
        valorPagamento,
        abatimentos
      });

      notify.success('Pagamento registrado com sucesso.');
      onClose(res.data);
    } catch (err) {
      console.error('[ERRO] registrar pagamento manual:', err);
      notify.error('Erro ao registrar pagamento.');
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-50 z-50">
      <div className="bg-white p-6 rounded-lg w-11/12 max-w-3xl max-h-[90vh] overflow-auto">
        <h2 className="text-2xl font-bold mb-4">Pagamento Manual</h2>
        <p className="text-lg">Pagamento do cliente: <strong>R$ {Number(valorPagamento || 0).toFixed(2)}</strong></p>
        <p className="text-lg mb-4">Saldo restante: <strong>R$ {Number(saldoRestante).toFixed(2)}</strong></p>

        <div className="space-y-4">
          {parcelas.map((p, i) => (
            <div
              key={p.id}
              className={`p-4 border-2 border-gray-300 rounded-lg shadow-sm ${p.pago ? 'bg-gray-100 text-gray-400' : 'bg-white'}`}
            >
              <p className="font-bold text-lg mb-1">
                {i + 1}ª Parcela: R$ {(p.valor_total - (p.abatidoTotal || 0)).toFixed(2)}
              </p>
              <p className="text-gray-700 mb-2">
                Capital: R$ {(p.valor_capital - (p.abatidoCapital || 0)).toFixed(2)} | Juros: R$ {(p.valor_juros - (p.abatidoJuros || 0)).toFixed(2)}
              </p>
              {!p.pago && (
                <div className="flex gap-2">
                  <button
                    className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded transition-colors"
                    onClick={async () => {
                      await handleAbater(i, 'total');
                    }}
                  >
                    Abater parcela
                  </button>
                  <button
                    className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded transition-colors"
                    onClick={async () => {
                      await handleAbater(i, 'capital');
                    }}
                  >
                    Abater capital
                  </button>
                  <button
                    className="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded transition-colors"
                    onClick={async () => {
                      await handleAbater(i, 'juros');
                    }}
                  >
                    Abater juros
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-6 flex justify-end gap-4 border-t pt-4">
          <button
            className="bg-red-500 hover:bg-red-600 text-white text-lg px-6 py-3 rounded transition-colors"
            onClick={() => onClose(null)}
          >
            Cancelar
          </button>
          <button
            className={`text-lg px-6 py-3 rounded transition-colors ${registrarHabilitado ? 'bg-green-600 hover:bg-green-700 text-white' : 'bg-gray-400 text-gray-200 cursor-not-allowed'}`}
            disabled={!registrarHabilitado}
            onClick={handleRegistrar}
          >
            Registrar
          </button>
        </div>
      </div>
    </div>
  );
}
