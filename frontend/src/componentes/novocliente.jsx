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

  // ===== estilos unificados modo escuro =====
  const containerStyle = {
    padding: 20,
    maxWidth: 700,
    margin: '0 auto',
    fontFamily: 'sans-serif',
    color: 'var(--text-main)',
  };

  const cardStyle = {
    background: 'var(--bg-card)',
    borderRadius: 8,
    border: '1px solid var(--border-soft)',
    padding: 20,
    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
  };

  const fieldStyle = {
    width: '100%',
    padding: 8,
    borderRadius: 4,
    border: '1px solid var(--border-soft)',
    background: 'var(--bg-body)',
    color: 'var(--text-main)',
    boxSizing: 'border-box',
  };

  const labelStyle = {
    display: 'block',
    marginBottom: 4,
    fontSize: 14,
    color: 'var(--text-main)',
  };

  const helperTextStyle = {
    fontSize: 12,
    color: 'var(--text-muted)',
  };

  const primaryButtonStyle = {
    marginTop: 16,
    width: '100%',
    padding: '10px 14px',
    borderRadius: 6,
    border: 'none',
    background: '#22c55e',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
  };

  const bloco = {
    marginBottom: 20,
    paddingBottom: 14,
    borderBottom: '1px solid var(--border-soft)',
  };

  const avisoId = { color: 'red', marginTop: 4 };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h2 style={{ textAlign: 'center', marginTop: 0, marginBottom: 20 }}>🧍‍♂️ Novo Cliente</h2>

        {/* ID opcional */}
        <div style={{ marginBottom: 20 }}>
          <label style={labelStyle}>ID (opcional)</label>
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
            style={fieldStyle}
            inputMode="numeric"
            pattern="\d*"
          />
          <div style={helperTextStyle}>Se deixar em branco, o sistema gera o ID automaticamente.</div>
          {idExiste && <div style={avisoId}>❌ Esse ID já existe! Escolha outro.</div>}
        </div>

        {/* Dados Pessoais */}
        <div style={bloco}>
          <h4 style={{ marginTop: 0, marginBottom: 10 }}>👤 Dados Pessoais</h4>

          <label style={labelStyle}>Nome</label>
          <input
            name="nome"
            value={form.nome}
            onChange={handleChange}
            style={fieldStyle}
          />

          <label style={labelStyle}>CPF</label>
          <input
            name="cpf"
            value={form.cpf}
            onChange={handleCPF}
            onBlur={onBlurCpf}
            style={fieldStyle}
          />
          {cpfExiste && (
            <div style={{ color: 'red', marginTop: 4 }}>
              ❌ CPF já cadastrado no sistema.
            </div>
          )}

          <label style={labelStyle}>Telefone</label>
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              name="ddd"
              value={form.ddd}
              onChange={handleChange}
              placeholder="DDD"
              style={{ ...fieldStyle, width: 70 }}
            />
            <input
              name="telefone"
              value={form.telefone}
              onChange={handleTelefone}
              placeholder="99999-9999"
              style={{ ...fieldStyle, flex: 1 }}
            />
          </div>
        </div>

        {/* Endereço */}
        <div style={bloco}>
          <h4 style={{ marginTop: 0, marginBottom: 10 }}>🏠 Endereço</h4>

          <label style={labelStyle}>Cidade</label>
          <input
            list="cidades"
            name="cidade"
            value={form.cidade}
            onChange={handleChange}
            placeholder="Escolha ou digite"
            style={fieldStyle}
          />
          <datalist id="cidades">
            <option value="Itumbiara" />
            <option value="Araporã" />
            <option value="Outra" />
          </datalist>

          {form.cidade === 'Outra' && (
            <input
              name="cidadeLivre"
              value={form.cidadeLivre}
              onChange={handleChange}
              placeholder="Digite a cidade"
              style={{ ...fieldStyle, marginTop: 8 }}
            />
          )}

          <label style={labelStyle}>Bairro</label>
          <input
            name="bairro"
            value={form.bairro}
            onChange={handleChange}
            style={fieldStyle}
          />

          <label style={labelStyle}>Rua</label>
          <input
            name="rua"
            value={form.rua}
            onChange={handleChange}
            style={fieldStyle}
          />

          <label style={labelStyle}>Número</label>
          <input
            name="numero"
            value={form.numero}
            onChange={handleChange}
            style={fieldStyle}
          />

          <label style={{ ...labelStyle, marginTop: 12 }}>
            <input
              type="checkbox"
              name="emPredio"
              checked={form.emPredio}
              onChange={handleChange}
              style={{ marginRight: 6 }}
            />
            🏢 Mora em prédio
          </label>

          {form.emPredio && (
            <>
              <input
                name="nomePredio"
                value={form.nomePredio}
                onChange={handleChange}
                placeholder="Nome do prédio"
                style={{ ...fieldStyle, marginTop: 8 }}
              />
              <input
                name="andar"
                value={form.andar}
                onChange={handleChange}
                placeholder="Andar"
                style={{ ...fieldStyle, marginTop: 8 }}
              />
              <input
                name="flat"
                value={form.flat}
                onChange={handleChange}
                placeholder="Flat/Nº Apto"
                style={{ ...fieldStyle, marginTop: 8 }}
              />
            </>
          )}
        </div>

        {/* Trabalho */}
        <div style={bloco}>
          <h4 style={{ marginTop: 0, marginBottom: 10 }}>💼 Trabalho</h4>

          <input
            name="empresa"
            value={form.empresa}
            onChange={handleChange}
            placeholder="Nome da empresa"
            style={fieldStyle}
          />
          <input
            name="ruaEmpresa"
            value={form.ruaEmpresa}
            onChange={handleChange}
            placeholder="Rua da empresa"
            style={{ ...fieldStyle, marginTop: 8 }}
          />
          <input
            name="bairroEmpresa"
            value={form.bairroEmpresa}
            onChange={handleChange}
            placeholder="Bairro da empresa"
            style={{ ...fieldStyle, marginTop: 8 }}
          />
          <input
            name="funcao"
            value={form.funcao}
            onChange={handleChange}
            placeholder="Função"
            style={{ ...fieldStyle, marginTop: 8 }}
          />
          <input
            name="telEmpresa"
            value={form.telEmpresa}
            onChange={handleChange}
            placeholder="Telefone"
            style={{ ...fieldStyle, marginTop: 8 }}
          />
        </div>

        {/* Extras */}
        <div style={bloco}>
          <h4 style={{ marginTop: 0, marginBottom: 10 }}>📝 Extras</h4>

          <label style={labelStyle}>Referência</label>
          <input
            name="referencia"
            value={form.referencia}
            onChange={handleChange}
            style={fieldStyle}
          />

          <label style={{ ...labelStyle, marginTop: 8 }}>Observação</label>
          <textarea
            name="observacao"
            value={form.observacao}
            onChange={handleChange}
            style={{ ...fieldStyle, minHeight: 80, resize: 'vertical' }}
          />
        </div>

        {/* Data */}
        <div style={bloco}>
          <h4 style={{ marginTop: 0, marginBottom: 10 }}>📅 Data de Cadastro</h4>
          <input
            name="criadoEm"
            type="date"
            value={form.criadoEm}
            onChange={handleChange}
            style={fieldStyle}
          />
        </div>

        <div style={{ marginTop: 20 }}>
          <button onClick={salvar} style={primaryButtonStyle}>
            Cadastrar Cliente
          </button>
        </div>
      </div>
    </div>
  );
}
