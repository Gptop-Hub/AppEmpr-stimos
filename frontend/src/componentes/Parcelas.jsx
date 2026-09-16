import React, { useEffect, useState } from 'react';
import axios from 'axios';
import notify from '../ui/notify';

export default function Parcelas({ emprestimoId }) {
  const [parcelas, setParcelas] = useState([]);
  const [nova, setNova] = useState({
    numero: '',
    valor_capital: '',
    valor_juros: '',
    vencimento: '',
    observacao: ''
  });

  useEffect(() => {
    if (emprestimoId) carregarParcelas();
  }, [emprestimoId]);

  const carregarParcelas = () => {
    axios
      .get(`/parcelas/${emprestimoId}`)
      .then(res => setParcelas(res.data))
      .catch(err => console.error(err));
  };

  const formatarMoeda = (v) =>
    Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const registrarParcela = () => {
    const { numero, valor_capital, valor_juros, vencimento } = nova;
    if (!numero || !valor_capital || !valor_juros || !vencimento) {
      notify.warn('Preencha todos os campos!');
      return;
    }

    axios.post('/parcelas', {
      emprestimo_id: emprestimoId,
      numero,
      valor_capital,
      valor_juros,
      vencimento,
      observacao: nova.observacao || ''
    }).then(() => {
      setNova({ numero: '', valor_capital: '', valor_juros: '', vencimento: '', observacao: '' });
      carregarParcelas();
    }).catch(err => {
      console.error(err);
      notify.error('Erro ao registrar parcela.');
    });
  };

  const atualizarParcela = (id, campo, valor) => {
    const parcelaAtual = parcelas.find(p => p.id === id);
    if (!parcelaAtual) return;

    const campoBackendMap = {
      capital: 'valor_capital',
      juros: 'valor_juros',
      vencimento: 'vencimento',
      pago: 'pago',
      observacao: 'observacao',
      valor_pago: 'valor_pago',
      data_pagamento: 'data_pagamento',
      juros_pendentes: 'juros_pendentes',
    };

    const campoBackend = campoBackendMap[campo];
    if (!campoBackend) return;

    const dadosAtualizados = {
      [campoBackend]: valor
    };

    axios
      .put(`/parcelas/${id}`, dadosAtualizados)
      .then(() => carregarParcelas())
      .catch(err => console.error(err));
  };

  /**
   * Regra de mudança de vencimento com opção de "empurrar todas".
   *
   * Agora:
   * - Se NÃO mudou mês/ano E não há colisão com outro vencimento -> single
   * - Se mudou mês/ano OU caiu num mês/ano onde já existe outra parcela,
   *   e existem parcelas posteriores -> pergunta se quer cascade
   */
  const handleVencimentoChange = (parcela, novaDataISO) => {
    if (!novaDataISO) {
      atualizarParcela(parcela.id, 'vencimento', '');
      return;
    }

    const novaData = new Date(novaDataISO);
    if (isNaN(novaData.getTime())) {
      notify.error('Data inválida.');
      return;
    }

    const antigo = parcela.vencimento ? new Date(parcela.vencimento) : null;

    const novoMes = novaData.getMonth();
    const novoAno = novaData.getFullYear();
    const antigoMes = antigo ? antigo.getMonth() : null;
    const antigoAno = antigo ? antigo.getFullYear() : null;

    const mudouMesOuAno =
      antigoMes === null ||
      antigoAno === null ||
      antigoMes !== novoMes ||
      antigoAno !== novoAno;

    // existe parcela NO MESMO MÊS/ANO (mesmo empréstimo, outra parcela)?
    const existeNoMesmoMesAno = parcelas.some((p) => {
      if (!p || p.id === parcela.id) return false;
      if (p.emprestimo_id !== parcela.emprestimo_id) return false;
      if (!p.vencimento) return false;
      const d = new Date(p.vencimento);
      if (isNaN(d.getTime())) return false;
      return d.getMonth() === novoMes && d.getFullYear() === novoAno;
    });

    // há parcelas posteriores neste empréstimo?
    const haProximas = parcelas.some((p) => {
      if (!p) return false;
      if (p.emprestimo_id !== parcela.emprestimo_id) return false;
      return Number(p.numero) > Number(parcela.numero);
    });

    let modo = 'single';

    // Só faz sentido oferecer cascade se tiver próximas
    if (haProximas && (mudouMesOuAno || existeNoMesmoMesAno)) {
      const querCascade = window.confirm(
        'Detectamos que este novo vencimento pode impactar as próximas parcelas.\n\n' +
        'OK = Empurrar esta e TODAS as próximas parcelas NÃO PAGAS em +1 mês, +2 meses, etc.\n' +
        'Cancelar = Alterar somente esta parcela.'
      );
      modo = querCascade ? 'cascade' : 'single';
    }

    axios.post(`/parcelas/${parcela.id}/reagendar`, {
      novaDataISO,
      modo,
    })
      .then(() => {
        carregarParcelas();
        if (modo === 'cascade') {
          notify.success('Vencimentos reagendados em cascata com sucesso.');
        } else {
          notify.success('Vencimento atualizado.');
        }
      })
      .catch((err) => {
        console.error(err);
        notify.error('Erro ao reagendar vencimento.');
      });
  };

  return (
    <div style={{ marginTop: 20 }}>
      <h3>Parcelas do Empréstimo</h3>

      <div style={{ marginBottom: 20, padding: 10, background: '#f1f1f1', borderRadius: 6 }}>
        <h4>Nova Parcela</h4>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            type="number"
            placeholder="Nº"
            value={nova.numero}
            onChange={e => setNova({ ...nova, numero: e.target.value })}
          />
          <input
            type="number"
            placeholder="Capital"
            value={nova.valor_capital}
            onChange={e => setNova({ ...nova, valor_capital: e.target.value })}
          />
          <input
            type="number"
            placeholder="Juros"
            value={nova.valor_juros}
            onChange={e => setNova({ ...nova, valor_juros: e.target.value })}
          />
          <input
            type="date"
            value={nova.vencimento}
            onChange={e => setNova({ ...nova, vencimento: e.target.value })}
          />
          <input
            type="text"
            placeholder="Observação"
            value={nova.observacao}
            onChange={e => setNova({ ...nova, observacao: e.target.value })}
          />
          <button onClick={registrarParcela}>Salvar</button>
        </div>
      </div>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {parcelas.map(parcela => (
          <li
            key={parcela.id}
            style={{
              marginBottom: 10,
              background: '#fafafa',
              padding: 10,
              borderRadius: 6
            }}
          >
            <div><strong>Parcela {parcela.numero}</strong></div>
            <div>
              Capital:
              <input
                type="number"
                value={parcela.valor_capital || ''}
                onChange={e => atualizarParcela(parcela.id, 'capital', e.target.value)}
              />
            </div>
            <div>
              Juros:
              <input
                type="number"
                value={parcela.valor_juros || ''}
                onChange={e => atualizarParcela(parcela.id, 'juros', e.target.value)}
              />
            </div>
            <div>
              Vencimento:
              <input
                type="date"
                value={parcela.vencimento ? parcela.vencimento.substring(0, 10) : ''}
                onChange={e => handleVencimentoChange(parcela, e.target.value)}
              />
            </div>

            <div>
              Pago:{' '}
              <input
                type="checkbox"
                checked={!!parcela.pago}
                onChange={e => atualizarParcela(parcela.id, 'pago', e.target.checked ? 1 : 0)}
              />
            </div>

            <div>
              Valor pago:
              <input
                type="number"
                value={parcela.valor_pago || ''}
                placeholder="R$"
                onChange={e => atualizarParcela(parcela.id, 'valor_pago', e.target.value)}
              />
            </div>

            <div>
              Data do pagamento:
              <input
                type="date"
                value={parcela.data_pagamento || ''}
                onChange={e => atualizarParcela(parcela.id, 'data_pagamento', e.target.value)}
              />
            </div>

            <div>
              Juros pendentes:
              <input
                type="number"
                value={parcela.juros_pendentes || ''}
                placeholder="R$"
                onChange={e => atualizarParcela(parcela.id, 'juros_pendentes', e.target.value)}
              />
            </div>

            <div>
              Observação:
              <input
                type="text"
                value={parcela.observacao}
                onChange={e => atualizarParcela(parcela.id, 'observacao', e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
