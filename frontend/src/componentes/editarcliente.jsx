import React, { useEffect, useState } from 'react';
import axios from 'axios';
import notify from '../ui/notify';

// ---------- Helpers ----------
const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

const maskCPF = (v) => {
  const d = soDigitos(v).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return d.replace(/(\d{3})(\d+)/, '$1.$2');
  if (d.length <= 9) return d.replace(/(\d{3})(\d{3})(\d+)/, '$1.$2.$3');
  return d.replace(/(\d{3})(\d{3})(\d{3})(\d{0,2})/, (_, a, b, c, rest) =>
    rest ? `${a}.${b}.${c}-${rest}` : `${a}.${b}.${c}`
  );
};

const maskTelefone9 = (v) => {
  const d = soDigitos(v).slice(0, 9);
  if (d.length <= 5) return d;
  return d.replace(/^(\d{5})(\d+)/, '$1-$2');
};

const extrairCampo = (texto, campo) => {
  if (!texto) return '';
  const regex = new RegExp(`${campo}:([^,]+)`, 'i');
  return regex.exec(texto)?.[1]?.trim() || '';
};

const capitalizeNome = (s) => {
  const t = (s || '').trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// --------------------------------

export default function EditarCliente({ cliente, onCancel, onSalvo }) {
  const [form, setForm] = useState({
    nome: '', cpf: '', ddd: '', telefone: '',
    cidade: '', cidadeLivre: '', bairro: '', rua: '', numero: '',
    emPredio: false, nomePredio: '', andar: '', flat: '',
    empresa: '', ruaEmpresa: '', bairroEmpresa: '', funcao: '', telEmpresa: '',
    referencia: '', observacao: '', criadoEm: ''
  });

  const [cpfExiste, setCpfExiste] = useState(false);

  // Preenche o formulário com dados existentes, aplicando máscaras
  useEffect(() => {
    if (!cliente) return;

    const ddd = cliente.telefone?.match(/\((\d{2})\)/)?.[1] || '';
    const tel = cliente.telefone?.replace(/\(\d{2}\)\s?/, '') || '';

    const dados = {
      nome: cliente.nome || '',
      cpf: maskCPF(cliente.cpf || ''),
      ddd,
      telefone: maskTelefone9(tel),
      cidade: extrairCampo(cliente.endereco, 'Cidade') || extrairCampo(cliente.endereco, 'cidade') || '',
      cidadeLivre: '',
      bairro: extrairCampo(cliente.endereco, 'Bairro') || extrairCampo(cliente.endereco, 'bairro') || '',
      rua: extrairCampo(cliente.endereco, 'Rua') || extrairCampo(cliente.endereco, 'rua') || '',
      numero: extrairCampo(cliente.endereco, 'Nº') || extrairCampo(cliente.endereco, 'nº') || '',
      emPredio: /Prédio:/i.test(cliente.endereco || ''),
      nomePredio: extrairCampo(cliente.endereco, 'Prédio') || extrairCampo(cliente.endereco, 'prédio') || '',
      andar: extrairCampo(cliente.endereco, 'Andar') || extrairCampo(cliente.endereco, 'andar') || '',
      flat: extrairCampo(cliente.endereco, 'Flat') || extrairCampo(cliente.endereco, 'flat') || '',

      empresa: extrairCampo(cliente.trabalho, 'Empresa') || extrairCampo(cliente.trabalho, 'empresa') || '',
      ruaEmpresa: extrairCampo(cliente.trabalho, 'Rua') || extrairCampo(cliente.trabalho, 'rua') || '',
      bairroEmpresa: extrairCampo(cliente.trabalho, 'Bairro') || extrairCampo(cliente.trabalho, 'bairro') || '',
      funcao: extrairCampo(cliente.trabalho, 'Função') || extrairCampo(cliente.trabalho, 'função') || '',
      telEmpresa: extrairCampo(cliente.trabalho, 'Telefone') || extrairCampo(cliente.trabalho, 'telefone') || '',

      referencia: cliente.referencia || '',
      observacao: cliente.observacao || '',
      criadoEm: (cliente.criadoEm?.split('T')[0]) || ''
    };

    setForm(dados);
    setCpfExiste(false);
  }, [cliente]);

  // Handlers de input com máscaras/limites (iguais ao NovoCliente)
  const onChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm((prev) => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    if (name === 'cpf') setCpfExiste(false);
  };

  const onChangeCPF = (e) => {
    setForm((prev) => ({ ...prev, cpf: maskCPF(e.target.value) }));
    setCpfExiste(false);
  };

  const onBlurCpf = async () => {
    const cpfClean = soDigitos(form.cpf);
    if (!cpfClean) {
      setCpfExiste(false);
      return;
    }
    try {
      // checa se existe algum cliente com esse CPF
      const res = await axios.get('http://localhost:3001/clientes/check-cpf', { params: { cpf: cpfClean } });
      const existe = !!(res.data && res.data.exists);

      // Se o CPF existe, mas é o mesmo do cliente atual, não é erro
      const cpfAtual = soDigitos(cliente?.cpf);
      setCpfExiste(existe && cpfClean !== cpfAtual);
    } catch (err) {
      console.error('Erro checando CPF (editar):', err);
      // Em erro de rede, não bloqueia edição
      setCpfExiste(false);
    }
  };

  const onChangeDDD = (e) => {
    const d = soDigitos(e.target.value).slice(0, 2);
    setForm((prev) => ({ ...prev, ddd: d }));
  };

  const onChangeTelefone = (e) => {
    setForm((prev) => ({ ...prev, telefone: maskTelefone9(e.target.value) }));
  };

  const handleSalvar = async () => {
    // validações simples
    if (!form.nome.trim() || !soDigitos(form.cpf) || !form.ddd || !soDigitos(form.telefone)) {
      notify.warn('Preencha Nome, CPF, DDD e Telefone.');
      return;
    }
    if (soDigitos(form.cpf).length !== 11) {
      notify.warn('CPF deve ter 11 dígitos.');
      return;
    }
    if (form.ddd.length !== 2) {
      notify.warn('DDD deve ter 2 dígitos.');
      return;
    }
    if (cpfExiste) {
      notify.error('CPF já cadastrado para outro cliente.');
      return;
    }

    const nome = capitalizeNome(form.nome);
    const cidadeFinal = form.cidade === 'Outra' ? form.cidadeLivre : form.cidade;

    let endereco = `Rua: ${form.rua}, Nº: ${form.numero}, Bairro: ${form.bairro}, Cidade: ${cidadeFinal}`;
    if (form.emPredio) {
      endereco += `, Prédio: ${form.nomePredio}, Andar: ${form.andar}, Flat: ${form.flat}`;
    }

    const trabalho = `Empresa: ${form.empresa}, Rua: ${form.ruaEmpresa}, Bairro: ${form.bairroEmpresa}, Função: ${form.funcao}, Telefone: ${form.telEmpresa}`;
    const telefone = `(${form.ddd}) ${form.telefone}`;
    const payload = {
      nome,
      cpf: soDigitos(form.cpf),        // envia apenas dígitos, igual NovoCliente
      telefone,
      endereco,
      trabalho,
      referencia: form.referencia,
      observacao: form.observacao,
      criadoEm: form.criadoEm
    };

    try {
      await axios.put(`http://localhost:3001/clientes/${cliente.id}`, payload);
      notify.success('Cliente editado com sucesso.');
      onSalvo && onSalvo();
    } catch (err) {
      if (err.response?.status === 409) {
        const msg = (err.response?.data?.error || '').toLowerCase();
        if (msg.includes('cpf')) {
          notify.error('CPF já cadastrado!');
          setCpfExiste(true);
          return;
        }
      }
      console.error(err);
      notify.error('Erro ao editar cliente.');
    }
  };

  const bloco = { marginBottom: 20, paddingBottom: 10, borderBottom: '1px solid #ccc' };
  const label = { display: 'block', marginTop: 8 };

  return (
    <div style={{ padding: 20, maxWidth: 600 }}>
      <h3>✏️ Editar Cliente</h3>

      {/* Dados Pessoais */}
      <div style={bloco}>
        <h4>👤 Dados Pessoais</h4>

        <label style={label}>Nome</label>
        <input name="nome" value={form.nome} onChange={onChange} />

        <label style={label}>CPF</label>
        <input name="cpf" value={form.cpf} onChange={onChangeCPF} onBlur={onBlurCpf} />
        {cpfExiste && <div style={{ color: 'red', marginTop: 4 }}>❌ CPF já cadastrado para outro cliente.</div>}

        <label style={label}>DDD / Telefone</label>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            name="ddd"
            value={form.ddd}
            onChange={onChangeDDD}
            placeholder="DD"
            style={{ width: 60 }}
            inputMode="numeric"
            pattern="\d*"
          />
          <input
            name="telefone"
            value={form.telefone}
            onChange={onChangeTelefone}
            placeholder="99999-9999"
            inputMode="numeric"
            pattern="\d*"
          />
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
          onChange={onChange}
          placeholder="Escolha ou digite"
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
            onChange={onChange}
            placeholder="Digite a cidade"
          />
        )}

        <label style={label}>Bairro</label>
        <input name="bairro" value={form.bairro} onChange={onChange} />

        <label style={label}>Rua</label>
        <input name="rua" value={form.rua} onChange={onChange} />

        <label style={label}>Número</label>
        <input name="numero" value={form.numero} onChange={onChange} />

        <label style={{ marginTop: 12 }}>
          <input type="checkbox" name="emPredio" checked={form.emPredio} onChange={onChange} /> 🏢 Mora em prédio
        </label>

        {form.emPredio && (
          <>
            <input name="nomePredio" value={form.nomePredio} onChange={onChange} placeholder="Nome do prédio" />
            <input name="andar" value={form.andar} onChange={onChange} placeholder="Andar" />
            <input name="flat" value={form.flat} onChange={onChange} placeholder="Flat/Nº Apto" />
          </>
        )}
      </div>

      {/* Trabalho */}
      <div style={bloco}>
        <h4>💼 Trabalho</h4>
        <input name="empresa" value={form.empresa} onChange={onChange} placeholder="Empresa" />
        <input name="ruaEmpresa" value={form.ruaEmpresa} onChange={onChange} placeholder="Rua da empresa" />
        <input name="bairroEmpresa" value={form.bairroEmpresa} onChange={onChange} placeholder="Bairro da empresa" />
        <input name="funcao" value={form.funcao} onChange={onChange} placeholder="Função" />
        <input name="telEmpresa" value={form.telEmpresa} onChange={onChange} placeholder="Telefone" />
      </div>

      {/* Extras */}
      <div style={bloco}>
        <h4>📝 Extras</h4>
        <label style={label}>Referência</label>
        <input name="referencia" value={form.referencia} onChange={onChange} />

        <label style={label}>Observação</label>
        <textarea name="observacao" value={form.observacao} onChange={onChange} />
      </div>

      {/* Data */}
      <div style={bloco}>
        <h4>📅 Cliente desde</h4>
        <input type="date" name="criadoEm" value={form.criadoEm} onChange={onChange} />
      </div>

      <div style={{ marginTop: 20, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onCancel}>Cancelar</button>
        <button onClick={handleSalvar}>Salvar Alterações</button>
      </div>
    </div>
  );
}