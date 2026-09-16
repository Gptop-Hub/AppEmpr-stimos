import React from 'react';
import { formatarMoeda } from './moeda';

export default function ResultadoTabela({ parcelas = [] }) {
  if (!Array.isArray(parcelas) || parcelas.length === 0) {
    return <div className="simulacao-empty">Preencha os campos para gerar as parcelas.</div>;
  }

  return (
    <div className="simulacao-resultado">
      <div className="simulacao-tabela-scroll">
        <table className="simulacao-tabela">
          <thead>
            <tr>
              <th className="simulacao-th">Parcela</th>
              <th className="simulacao-th">Valor total</th>
              <th className="simulacao-th">Valor capital</th>
              <th className="simulacao-th">Valor juros</th>
            </tr>
          </thead>
          <tbody>
            {parcelas.map((p) => (
              <tr key={p.numero}>
                <td className="simulacao-td">#{p.numero}</td>
                <td className="simulacao-td">{formatarMoeda(p.valor_total)}</td>
                <td className="simulacao-td">{formatarMoeda(p.valor_capital)}</td>
                <td className="simulacao-td">{formatarMoeda(p.valor_juros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
