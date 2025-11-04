import React, { useEffect, useState } from 'react';
import axios from 'axios';
import notify from '../ui/notify';

export default function EditarCliente({ cliente, onCancel, onSalvo }) {
  const [form, setForm] = useState({
    nome: '', cpf: '', ddd: '', telefone: '',
    cidade: '', cidadeLivre: '', bairro: '', rua: '', numero: '',
    emPredio: false, nomePredio: '', andar: '', flat: '',
    empresa: '', ruaEmpresa: '', bairroEmpresa: '', funcao: '', telEmpresa: '',
    referencia: '', observacao: '', criadoEm: ''
  });

  useEffect(() => {
    if (cliente) {
      const dados = {
        ...form,
        nome: cliente.nome || '',
        cpf: cliente.cpf || '',
        ddd: cliente.telefone?.slice(1, 3) || '',
        telefone: cliente.telefone?.slice(5) || '',
        cidade: extrairCampo(cliente.endereco, 'cidade') || '',
        cidadeLivre: '',
        bairro: extrairCampo(cliente.endereco, 'bairro') || '',
        rua: extrairCampo(cliente.endereco, 'rua') || '',
        numero: extrairCampo(cliente.endereco, 'nº') || '',
        emPredio: cliente.endereco?.includes('Prédio:'),
        nomePredio: extrairCampo(cliente.endereco, 'prédio') || '',
        andar: extrairCampo(cliente.endereco, 'andar') || '',
        flat: extrairCampo(cliente.endereco, 'flat') || '',
        empresa: extrairCampo(cliente.trabalho, 'empresa') || '',
        ruaEmpresa: extrairCampo(cliente.trabalho, 'rua') || '',
        bairroEmpresa: extrairCampo(cliente.trabalho, 'bairro') || '',
        funcao: extrairCampo(cliente.trabalho, 'função') || '',
        telEmpresa: extrairCampo(cliente.trabalho, 'telefone') || '',
        referencia: cliente.referencia || '',
        observacao: cliente.observacao || '',
        criadoEm: cliente.criadoEm?.split('T')[0] || ''
      };
      setForm(dados);
    }
  }, [cliente]);

  const extrairCampo = (texto, campo) => {
    const regex = new RegExp(`${campo}:([^,]+)`, 'i');
    return regex.exec(texto)?.[1]?.trim() || '';
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm({ ...form, [name]: type === 'checkbox' ? checked : value });
  };

  const handleSalvar = async () => {
    const cidadeFinal = form.cidade === 'Outra' ? form.cidadeLivre : form.cidade;

    let endereco = `Rua: ${form.rua}, Nº: ${form.numero}, Bairro: ${form.bairro}, Cidade: ${cidadeFinal}`;
    if (form.emPredio) {
      endereco += `, Prédio: ${form.nomePredio}, Andar: ${form.andar}, Flat: ${form.flat}`;
    }

    const trabalho = `Empresa: ${form.empresa}, Rua: ${form.ruaEmpresa}, Bairro: ${form.bairroEmpresa}, Função: ${form.funcao}, Telefone: ${form.telEmpresa}`;
    const telefone = `(${form.ddd}) ${form.telefone}`;

    const data = {
      nome: form.nome.trim(),
      cpf: form.cpf,
      telefone,
      endereco,
      trabalho,
      referencia: form.referencia,
      observacao: form.observacao,
      criadoEm: form.criadoEm
    };

    try {
      await axios.put(`http://localhost:3001/clientes/${cliente.id}`, data);
      notify.success('Cliente editado com sucesso.');
      onSalvo();
    } catch (err) {
      console.error(err);
      notify.error('Erro ao editar cliente.');
    }
  };

  const label = { display: 'block', marginTop: 8 };

  return (
    <div style={{ padding: 20 }}>
      <h3>Editar Cliente</h3>
      <label style={label}>Nome</label>
      <input name="nome" value={form.nome} onChange={handleChange} />

      <label style={label}>CPF</label>
      <input name="cpf" value={form.cpf} onChange={handleChange} />

      <label style={label}>DDD / Telefone</label>
      <div style={{ display: 'flex', gap: 10 }}>
        <input name="ddd" value={form.ddd} onChange={handleChange} placeholder="DDD" style={{ width: 60 }} />
        <input name="telefone" value={form.telefone} onChange={handleChange} placeholder="99999-9999" />
      </div>

      <h4 style={{ marginTop: 20 }}>Endereço</h4>
      <input name="cidade" value={form.cidade} onChange={handleChange} placeholder="Cidade" />
      {form.cidade === 'Outra' && (
        <input name="cidadeLivre" value={form.cidadeLivre} onChange={handleChange} placeholder="Digite a cidade" />
      )}
      <input name="bairro" value={form.bairro} onChange={handleChange} placeholder="Bairro" />
      <input name="rua" value={form.rua} onChange={handleChange} placeholder="Rua" />
      <input name="numero" value={form.numero} onChange={handleChange} placeholder="Número" />

      <label style={{ marginTop: 12 }}>
        <input type="checkbox" name="emPredio" checked={form.emPredio} onChange={handleChange} /> 🏢 Mora em prédio
      </label>
      {form.emPredio && (
        <>
          <input name="nomePredio" value={form.nomePredio} onChange={handleChange} placeholder="Nome do prédio" />
          <input name="andar" value={form.andar} onChange={handleChange} placeholder="Andar" />
          <input name="flat" value={form.flat} onChange={handleChange} placeholder="Flat" />
        </>
      )}

      <h4 style={{ marginTop: 20 }}>Trabalho</h4>
      <input name="empresa" value={form.empresa} onChange={handleChange} placeholder="Empresa" />
      <input name="ruaEmpresa" value={form.ruaEmpresa} onChange={handleChange} placeholder="Rua" />
      <input name="bairroEmpresa" value={form.bairroEmpresa} onChange={handleChange} placeholder="Bairro" />
      <input name="funcao" value={form.funcao} onChange={handleChange} placeholder="Função" />
      <input name="telEmpresa" value={form.telEmpresa} onChange={handleChange} placeholder="Telefone" />

      <h4 style={{ marginTop: 20 }}>Extras</h4>
      <input name="referencia" value={form.referencia} onChange={handleChange} placeholder="Referência" />
      <textarea name="observacao" value={form.observacao} onChange={handleChange} placeholder="Observação" />

      <label style={label}>Cliente desde:</label>
      <input type="date" name="criadoEm" value={form.criadoEm} onChange={handleChange} />

      <div style={{ marginTop: 20, display: 'flex', justifyContent: 'space-between' }}>
        <button onClick={onCancel}>Cancelar</button>
        <button onClick={handleSalvar}>Salvar Alterações</button>
      </div>
    </div>
  );
}
