import React, { useState } from 'react';
import axios from 'axios';
import notify from '../ui/notify';

export default function NovoCliente() {
  const hoje = new Date().toISOString().split('T')[0];

  const formInicial = {
    id: '',
    nome: '', cpf: '', ddd: '', telefone: '',
    cidade: '', cidadeLivre: '', bairro: '', rua: '', numero: '',
    emPredio: false, nomePredio: '', andar: '', flat: '',
    empresa: '', ruaEmpresa: '', bairroEmpresa: '', funcao: '', telEmpresa: '',
    referencia: '', observacao: '', criadoEm: hoje
  };

  const [form, setForm] = useState(formInicial);

  // Para mostrar se ID já existe ao sair do campo
  const [idExiste, setIdExiste] = useState(false);

  // Para mostrar se CPF já existe
  const [cpfExiste, setCpfExiste] = useState(false);

  const handleChange = e => {
    const { name, value, type, checked } = e.target;
    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    if (name === 'id') setIdExiste(false); // limpa o aviso ao digitar no id
    if (name === 'cpf') setCpfExiste(false); // limpa o aviso ao digitar no cpf
  };

  const handleCPF = e => {
    let v = e.target.value.replace(/\D/g, '').slice(0, 11);
    v = v.replace(/^(\d{3})(\d)/, '$1.$2')
         .replace(/(\d{3})(\d)/, '$1.$2')
         .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    setForm(prev => ({ ...prev, cpf: v }));
    setCpfExiste(false);
  };

  const handleTelefone = e => {
    let v = e.target.value.replace(/\D/g, '').slice(0, 9);
    if (v.length > 5) v = v.replace(/^(\d{5})(\d+)/, '$1-$2');
    setForm(prev => ({ ...prev, telefone: v }));
  };

  // Função para checar se o ID existe no backend
  const checarIdExiste = async (id) => {
    try {
      const res = await axios.get(`http://localhost:3001/clientes/check-id/${id}`);
      return res.data.exists;
    } catch (error) {
      console.error('Erro ao checar ID:', error);
      return false;
    }
  };

  // Função chamada ao sair do campo ID (onBlur)
  const onBlurId = async () => {
    if (form.id.trim()) {
      const idNum = parseInt(form.id, 10);
      if (!isNaN(idNum)) {
        const existe = await checarIdExiste(idNum);
        setIdExiste(existe);
      } else {
        setIdExiste(false);
      }
    } else {
      setIdExiste(false);
    }
  };

  // limpa CPF (apenas dígitos)
  const cpfDigits = (cpfFormatted) => String(cpfFormatted || '').replace(/\D/g, '');

  // checar cpf via endpoint novo
  const checarCpfExiste = async (cpfValue) => {
    try {
      const cpfClean = cpfDigits(cpfValue);
      if (!cpfClean) return false;
      const res = await axios.get(`http://localhost:3001/clientes/check-cpf`, { params: { cpf: cpfClean } });
      return res.data && res.data.exists;
    } catch (err) {
      console.error('Erro checando CPF:', err);
      return false;
    }
  };

  const onBlurCpf = async () => {
    const cpfClean = cpfDigits(form.cpf);
    if (!cpfClean) {
      setCpfExiste(false);
      return;
    }
    const existe = await checarCpfExiste(cpfClean);
    setCpfExiste(existe);
  };

  const salvar = async () => {
    if (!form.nome.trim() || !form.cpf.trim() || !form.telefone.trim() || !form.criadoEm) {
      notify.warn('Por favor, preencha os campos obrigatorios: Nome, CPF, Telefone e Data.');
      return;
    }

    if (form.id.trim()) {
      const idNum = parseInt(form.id, 10);
      if (isNaN(idNum)) {
        notify.warn('ID deve ser um numero valido.');
        return;
      }
      if (idExiste) {
        notify.error('Esse ID ja existe! Escolha outro ou deixe em branco.');
        return;
      }
    }

    if (cpfExiste) {
      notify.error('CPF ja cadastrado. Verifique ou edite o cliente existente.');
      return;
    }

    const nomeFormatado = form.nome.trim().charAt(0).toUpperCase() + form.nome.trim().slice(1);
    const cidadeFinal = form.cidade === 'Outra' ? form.cidadeLivre : form.cidade;

    let endereco = `Rua: ${form.rua}, Nº: ${form.numero}, Bairro: ${form.bairro}, Cidade: ${cidadeFinal}`;
    if (form.emPredio) {
      endereco += `, Prédio: ${form.nomePredio}, Andar: ${form.andar}, Flat: ${form.flat}`;
    }

    const trabalho = `Empresa: ${form.empresa}, Rua: ${form.ruaEmpresa}, Bairro: ${form.bairroEmpresa}, Função: ${form.funcao}, Telefone: ${form.telEmpresa}`;
    const telefone = `(${form.ddd}) ${form.telefone}`;

    const payload = {
      nome: nomeFormatado,
      // envia CPF apenas com dígitos (backend espera/normaliza)
      cpf: cpfDigits(form.cpf),
      telefone,
      endereco,
      trabalho,
      referencia: form.referencia,
      observacao: form.observacao,
      criadoEm: form.criadoEm
    };

    if (form.id.trim()) {
      payload.id = parseInt(form.id, 10);
    }

    try {
      const res = await axios.post('http://localhost:3001/clientes', payload);
      notify.success(`Cliente cadastrado! ID: ${res.data.id}`);
      setForm(formInicial);
      setIdExiste(false);
      setCpfExiste(false);
    } catch (err) {
      // tratar CPF duplicado vindo do backend
      if (err.response?.status === 409) {
        const msg = err.response?.data?.error || '';
        if (msg.toLowerCase().includes('cpf')) {
          notify.error('CPF ja cadastrado!');
          setCpfExiste(true);
          return;
        }
        if (msg.toLowerCase().includes('id')) {
          notify.error('Esse ID ja existe! Escolha outro ou deixe em branco.');
          setIdExiste(true);
          return;
        }
        notify.error('Registro duplicado (409). Veja console.');
        return;
      }
      console.error(err);
      notify.error('Erro ao cadastrar. Veja console.');
    }
  };

  const bloco = { marginBottom: 20, paddingBottom: 10, borderBottom: '1px solid #ccc' };
  const label = { display: 'block', marginTop: 8 };
  const avisoId = { color: 'red', marginTop: 4 };

  return (
    <div style={{ maxWidth: 600, margin: 'auto', padding: 20 }}>
      <h2 style={{ textAlign: 'center' }}>🧍‍♂️ Novo Cliente</h2>

      {/* ID opcional */}
      <div style={{ marginBottom: 20 }}>
        <label style={label}>ID (opcional)</label>
        <input
          name="id"
          value={form.id}
          onChange={(e) => {
            const somenteNumeros = e.target.value.replace(/\D/g, '');
            setForm(prev => ({ ...prev, id: somenteNumeros }));
            setIdExiste(false);
          }}
          onBlur={onBlurId}
          placeholder="Se vazio, será automático"
          style={{ width: '100%', padding: 8 }}
          inputMode="numeric"
          pattern="\d*"
        />
        {idExiste && <div style={avisoId}>❌ Esse ID já existe! Escolha outro.</div>}
      </div>

      {/* Dados Pessoais */}
      <div style={bloco}>
        <h4>👤 Dados Pessoais</h4>
        <label style={label}>Nome</label>
        <input name="nome" value={form.nome} onChange={handleChange} />

        <label style={label}>CPF</label>
        <input name="cpf" value={form.cpf} onChange={handleCPF} onBlur={onBlurCpf} />
        {cpfExiste && <div style={{ color: 'red', marginTop: 4 }}>❌ CPF já cadastrado no sistema.</div>}

        <label style={label}>Telefone</label>
        <div style={{ display: 'flex', gap: 10 }}>
          <input name="ddd" value={form.ddd} onChange={handleChange} placeholder="DDD" style={{ width: 60 }} />
          <input name="telefone" value={form.telefone} onChange={handleTelefone} placeholder="99999-9999" />
        </div>
      </div>

      {/* Endereço */}
      <div style={bloco}>
        <h4>🏠 Endereço</h4>
        <label style={label}>Cidade</label>
        <input
          list="cidades"
          name="cidade"
          value={form.cidade}
          onChange={handleChange}
          placeholder="Escolha ou digite"
        />
        <datalist id="cidades">
          <option value="Itumbiara" />
          <option value="Araporã" />
          <option value="Outra" />
        </datalist>
        {form.cidade === 'Outra' && (
          <input name="cidadeLivre" value={form.cidadeLivre} onChange={handleChange} placeholder="Digite a cidade" />
        )}

        <label style={label}>Bairro</label>
        <input name="bairro" value={form.bairro} onChange={handleChange} />

        <label style={label}>Rua</label>
        <input name="rua" value={form.rua} onChange={handleChange} />

        <label style={label}>Número</label>
        <input name="numero" value={form.numero} onChange={handleChange} />

        <label style={{ marginTop: 12 }}>
          <input type="checkbox" name="emPredio" checked={form.emPredio} onChange={handleChange} /> 🏢 Mora em prédio
        </label>

        {form.emPredio && (
          <>
            <input name="nomePredio" value={form.nomePredio} onChange={handleChange} placeholder="Nome do prédio" />
            <input name="andar" value={form.andar} onChange={handleChange} placeholder="Andar" />
            <input name="flat" value={form.flat} onChange={handleChange} placeholder="Flat/Nº Apto" />
          </>
        )}
      </div>

      {/* Trabalho */}
      <div style={bloco}>
        <h4>💼 Trabalho</h4>
        <input name="empresa" value={form.empresa} onChange={handleChange} placeholder="Nome da empresa" />
        <input name="ruaEmpresa" value={form.ruaEmpresa} onChange={handleChange} placeholder="Rua da empresa" />
        <input name="bairroEmpresa" value={form.bairroEmpresa} onChange={handleChange} placeholder="Bairro da empresa" />
        <input name="funcao" value={form.funcao} onChange={handleChange} placeholder="Função" />
        <input name="telEmpresa" value={form.telEmpresa} onChange={handleChange} placeholder="Telefone" />
      </div>

      {/* Extras */}
      <div style={bloco}>
        <h4>📝 Extras</h4>
        <label style={label}>Referência</label>
        <input name="referencia" value={form.referencia} onChange={handleChange} />

        <label style={label}>Observação</label>
        <textarea name="observacao" value={form.observacao} onChange={handleChange} />
      </div>

      {/* Data */}
      <div style={bloco}>
        <h4>📅 Data de Cadastro</h4>
        <input name="criadoEm" type="date" value={form.criadoEm} onChange={handleChange} />
      </div>

      <div style={{ textAlign: 'center', marginTop: 30 }}>
        <button onClick={salvar} style={{ padding: 10, width: '100%' }}>
          Cadastrar Cliente
        </button>
      </div>
    </div>
  );
}
