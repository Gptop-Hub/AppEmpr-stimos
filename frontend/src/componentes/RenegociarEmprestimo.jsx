import React, { useState, useEffect } from 'react'; 
import axios from 'axios';
import { formatarMoedaNumero, desformatarMoeda } from '../utils/formatacao';
import { renderLinhaJuros } from './Emprestimos/helpers.jsx';
import notify from '../ui/notify';
import StepperInput from './common/StepperInput.jsx';

export default function RenegociarEmprestimo({ 
  emprestimoId,
  onClose,
  onRenegociado,
  defaults: { novoCapital, parcelasRestantes, taxaJuros, dataInicio, diaPagamento }
}) {
  const [valor, setValor] = useState(formatarMoedaNumero(novoCapital) || '');
  const [parcelas, setParcelas] = useState(parcelasRestantes || 1);
  const [taxa, setTaxa] = useState(taxaJuros !== undefined ? taxaJuros : 0);
  const [data, setData] = useState(dataInicio || '');
  const [dia, setDia] = useState(diaPagamento || 1);
  const [observacao, setObservacao] = useState('');
  const [parcelasPreview, setParcelasPreview] = useState([]);

  function calcularParcelasPreview(capitalTotal, taxa, qtdParcelas) {
    if (qtdParcelas <= 0) return [];
    const parcelasCalc = [];
    const capitalParcela = capitalTotal / qtdParcelas;

    for (let i = 0; i < qtdParcelas; i++) {
      const jurosParcela = (capitalTotal - capitalParcela * i) * (taxa / 100);
      const valorTotal = capitalParcela + jurosParcela;

      parcelasCalc.push({
        numero: i + 1,
        valor: valorTotal,
        capital: capitalParcela,
        juros: jurosParcela,
      });
    }

    return parcelasCalc;
  }

  useEffect(() => {
    const capitalNum = desformatarMoeda(valor) || 0;
    if (capitalNum > 0 && taxa >= 0 && parcelas > 0) {
      const preview = calcularParcelasPreview(capitalNum, taxa, parcelas);
      setParcelasPreview(preview);
    } else {
      setParcelasPreview([]);
    }
  }, [valor, taxa, parcelas]);

  const salvarRenegociacao = () => {
    const dadosParaSalvar = {
      emprestimo_id: emprestimoId,
      novo_capital: desformatarMoeda(valor) || 0,
      qtd_parcelas: parcelas || 1,
      taxa_juros: taxa || 0,
      data_inicio: data || '',
      dia_pagamento: dia || 1,
      observacao
    };

    console.log('Enviando renegociação:', dadosParaSalvar);

    axios.post('/renegociar', dadosParaSalvar)
      .then(() => {
        notify.success('Renegociacao concluida.');
        if (onRenegociado) onRenegociado();
        if (onClose) onClose();
      })
      .catch(error => {
        console.error('Erro ao renegociar:', error.response || error.message || error);
        notify.error('Erro ao renegociar: ' + (error.response?.data?.erro || error.message || ''));
      });
  };

  return (
    <div style={{
      padding: '24px',
      background: '#f9f9f9',
      borderRadius: '12px',
      maxWidth: '600px',
      margin: '0 auto',
      boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
      fontFamily: 'Arial, sans-serif'
    }}>
      <h2 style={{ marginBottom: '20px' }}>Renegociar Empréstimo (ID: {emprestimoId})</h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <label>
          Valor (novo capital)
          <input
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            style={inputStyle}
            placeholder="0,00"
          />
        </label>

        <label>
          Parcelas
          <StepperInput
            value={parcelas}
            onChange={setParcelas}
            min={1}
            inputAriaLabel="Quantidade de parcelas"
            style={{ marginTop: 4 }}
          />
        </label>

        <label>
          Taxa de Juros (%)
          <input
            type="number"
            step="0.01"
            value={taxa}
            min={0}
            onChange={(e) => setTaxa(Number(e.target.value) || 0)}
            style={inputStyle}
          />
        </label>

        <label>
          Data Início
          <input
            type="date"
            value={data}
            onChange={(e) => setData(e.target.value)}
            style={inputStyle}
          />
        </label>

        <label>
          Dia do Pagamento
          <input
            type="number"
            value={dia}
            min={1}
            max={31}
            onChange={(e) => {
              let v = Number(e.target.value);
              if (v < 1) v = 1;
              if (v > 31) v = 31;
              setDia(v);
            }}
            style={inputStyle}
          />
        </label>

        <label>
          Observação
          <textarea
            value={observacao}
            onChange={(e) => setObservacao(e.target.value)}
            style={{ ...inputStyle, height: '60px', resize: 'vertical' }}
          />
        </label>
      </div>

      {parcelasPreview.length > 0 && (
        <div style={{ 
          marginTop: '20px', 
          background: '#fff', 
          padding: '12px', 
          borderRadius: '8px', 
          boxShadow: 'inset 0 0 6px #ccc',
          maxHeight: '250px',      // limite de altura
          overflowY: 'auto'       // barra de rolagem vertical
        }}>
          <h3>Pré-visualização de Parcelas</h3>
          <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
            {parcelasPreview.map(p => (
              <li key={p.numero} style={{ marginBottom: '8px', fontSize: '14px' }}>
                <strong>{p.numero}ª:</strong> R$ {p.valor.toFixed(2)} <br />
                <small>
                  (
                  {renderLinhaJuros(
                    {
                      valor_capital: p.capital,
                      valor_juros: p.juros,
                      juros_pendentes: 0,
                      juros_adicionais: 0,
                    },
                    formatarMoedaNumero
                  )}
                  )
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{
        marginTop: '24px',
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '12px'
      }}>
        <button onClick={salvarRenegociacao} style={buttonStyleGreen}>
          Salvar
        </button>
        <button onClick={onClose} style={buttonStyleRed}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '8px 10px',
  fontSize: '15px',
  border: '1px solid #ccc',
  borderRadius: '6px',
  marginTop: '4px'
};

const buttonStyleGreen = {
  backgroundColor: '#4CAF50',
  color: 'white',
  padding: '10px 16px',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer'
};

const buttonStyleRed = {
  backgroundColor: '#e74c3c',
  color: 'white',
  padding: '10px 16px',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer'
};
