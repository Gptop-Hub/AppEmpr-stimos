import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import notify from '../ui/notify';
import {
  CLIENT_PHOTO_ACCEPT,
  formatarTamanhoFoto,
  prepararFotoCliente,
} from './common/clientePhotoProcessing';
import ClientePhotoZoom from './common/ClientePhotoZoom.jsx';

const hojeLocalISO = () => {
  const d = new Date();
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
};

export default function NovoCliente() {
  const navigate = useNavigate();
  const hoje = hojeLocalISO();

  const formInicial = {
    id: '',
    nome: '', cpf: '', ddd: '', telefone: '',
    cidade: '', cidadeLivre: '', bairro: '', rua: '', numero: '',
    emPredio: false, nomePredio: '', andar: '', flat: '',
    empresa: '', categoriaTrabalho: '', bairroEmpresa: '', ruaEmpresa: '', numeroEmpresa: '', funcao: '', telEmpresa: '',
    referencia: '', observacao: '', criadoEm: hoje
  };

  const [form, setForm] = useState(formInicial);
  const [hoverQuick, setHoverQuick] = useState(null);
  const [fotoArquivo, setFotoArquivo] = useState(null);
  const [fotoPreview, setFotoPreview] = useState('');
  const [fotoNomeOriginal, setFotoNomeOriginal] = useState('');
  const [processandoFoto, setProcessandoFoto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const fotoInputRef = useRef(null);

  // Para mostrar se ID já existe ao sair do campo
  const [idExiste, setIdExiste] = useState(false);

  // Para mostrar se CPF já existe
  const [cpfExiste, setCpfExiste] = useState(false);

  useEffect(
    () => () => {
      if (fotoPreview) URL.revokeObjectURL(fotoPreview);
    },
    [fotoPreview]
  );

  const selecionarFoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setProcessandoFoto(true);
    try {
      const fotoPreparada = await prepararFotoCliente(file);
      setFotoArquivo(fotoPreparada);
      setFotoNomeOriginal(file.name);
      setFotoPreview(URL.createObjectURL(fotoPreparada));
    } catch (err) {
      notify.error(err?.message || 'Não foi possível preparar a foto.');
    } finally {
      setProcessandoFoto(false);
    }
  };

  const removerFotoSelecionada = () => {
    setFotoArquivo(null);
    setFotoPreview('');
    setFotoNomeOriginal('');
  };

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
      const res = await axios.get(`/clientes/check-id/${id}`);
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
      const res = await axios.get(`/clientes/check-cpf`, { params: { cpf: cpfClean } });
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

    const trabalho = `Empresa: ${form.empresa}, Categoria: ${form.categoriaTrabalho}, Bairro: ${form.bairroEmpresa}, Rua: ${form.ruaEmpresa}, Nº: ${form.numeroEmpresa}, Função: ${form.funcao}, Telefone: ${form.telEmpresa}`;
    const telefone = `(${form.ddd}) ${form.telefone}`;

    const payload = {
      nome: nomeFormatado,
      // envia CPF apenas com dígitos (backend espera/normaliza)
      cpf: cpfDigits(form.cpf),
      telefone,
      endereco,
      trabalho,
      categoria_trabalho: form.categoriaTrabalho,
      referencia: form.referencia,
      observacao: form.observacao,
      criadoEm: form.criadoEm
    };

    if (form.id.trim()) {
      payload.id = parseInt(form.id, 10);
    }

    if (processandoFoto) {
      notify.warn('Aguarde a foto terminar de ser preparada.');
      return;
    }
    if (salvando) return;
    setSalvando(true);

    try {
      const res = await axios.post('/clientes', payload);
      let fotoSalva = true;

      if (fotoArquivo) {
        const fotoData = new FormData();
        fotoData.append('foto', fotoArquivo);
        try {
          await axios.post(
            `/clientes/${res.data.id}/foto`,
            fotoData
          );
        } catch (fotoErr) {
          fotoSalva = false;
          console.error('Cliente criado, mas houve erro ao salvar a foto:', fotoErr);
        }
      }

      setForm(formInicial);
      setIdExiste(false);
      setCpfExiste(false);
      setFotoArquivo(null);
      setFotoPreview('');
      setFotoNomeOriginal('');

      if (fotoSalva) {
        notify.success(`Cliente cadastrado! ID: ${res.data.id}`);
      } else {
        notify.warn(
          `Cliente cadastrado com ID ${res.data.id}, mas a foto não foi salva. Tente novamente na edição.`
        );
      }
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
    } finally {
      setSalvando(false);
    }
  };

  const onEnterSubmit = (e) => {
    if (e.key !== 'Enter') return;
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    if (e.target && e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    salvar();
  };

  // ===== estilos unificados modo escuro =====
  const containerStyle = {
    padding: 20,
    maxWidth: 'min(980px, var(--main-max-effective, var(--main-max)))',
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

  const backButtonStyle = {
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid var(--border-soft)',
    background: 'var(--bg-body)',
    color: 'var(--text-main)',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 13,
  };

  const bloco = {
    marginBottom: 20,
    paddingBottom: 14,
    borderBottom: '1px solid var(--border-soft)',
  };

  const avisoId = { color: 'red', marginTop: 4 };

  return (
    <div style={containerStyle}>
      <div style={cardStyle} onKeyDown={onEnterSubmit}>
        <div style={{ marginBottom: 10 }}>
          <button
            type="button"
            onClick={() => navigate('/clientes')}
            style={backButtonStyle}
          >
            ← Voltar para Clientes
          </button>
        </div>
        <h2 style={{ textAlign: 'center', marginTop: 0, marginBottom: 20 }}>Novo Cliente</h2>

        <div style={bloco}>
          <div className="cliente-photo-field">
            <ClientePhotoZoom
              nome={form.nome}
              src={fotoPreview}
              size={112}
              className="cliente-photo-field__preview"
            />
            <div className="cliente-photo-field__content">
              <span className="cliente-photo-field__title">Foto do cliente</span>
              <input
                ref={fotoInputRef}
                type="file"
                accept={CLIENT_PHOTO_ACCEPT}
                onChange={selecionarFoto}
                hidden
              />
              <div className="cliente-photo-field__actions">
                <button
                  type="button"
                  className="cliente-photo-button"
                  onClick={() => fotoInputRef.current?.click()}
                  disabled={salvando || processandoFoto}
                >
                  {processandoFoto
                    ? 'Preparando foto...'
                    : fotoArquivo
                      ? 'Trocar foto'
                      : 'Selecionar foto'}
                </button>
                {fotoArquivo ? (
                  <button
                    type="button"
                    className="cliente-photo-button cliente-photo-button--danger"
                    onClick={removerFotoSelecionada}
                    disabled={salvando || processandoFoto}
                  >
                    Remover foto
                  </button>
                ) : null}
              </div>
              <p className="cliente-photo-field__help">
                {processandoFoto
                  ? 'Otimizando a imagem selecionada...'
                  : fotoArquivo
                    ? `${fotoNomeOriginal} - ${formatarTamanhoFoto(fotoArquivo.size)}`
                    : 'Selecione uma imagem; fotos grandes serão otimizadas.'}
              </p>
            </div>
          </div>
        </div>

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
          {idExiste && <div style={avisoId}>Esse ID já existe. Escolha outro.</div>}
        </div>

        {/* Dados Pessoais */}
        <div style={bloco}>
          <h4 style={{ marginTop: 0, marginBottom: 10 }}>Dados Pessoais</h4>

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
              CPF já cadastrado no sistema.
            </div>
          )}

          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              flexWrap: 'wrap',
              marginBottom: 6,
            }}
          >
            <span style={labelStyle}>Telefone</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    ddd: '064',
                  }))
                }
                onMouseEnter={() => setHoverQuick('ddd-064')}
                onMouseLeave={() => setHoverQuick(null)}
                style={{
                  padding: '6px 10px',
                  borderRadius: 999,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-main)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  boxShadow:
                    hoverQuick === 'ddd-064'
                      ? '0 6px 16px rgba(37, 99, 235, 0.25)'
                      : 'none',
                  transform: hoverQuick === 'ddd-064' ? 'translateY(-1px)' : 'none',
                  transition: 'box-shadow 120ms ease, transform 120ms ease',
                }}
              >
                064
              </button>
              <button
                type="button"
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    ddd: '062',
                  }))
                }
                onMouseEnter={() => setHoverQuick('ddd-062')}
                onMouseLeave={() => setHoverQuick(null)}
                style={{
                  padding: '6px 10px',
                  borderRadius: 999,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-main)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  boxShadow:
                    hoverQuick === 'ddd-062'
                      ? '0 6px 16px rgba(37, 99, 235, 0.25)'
                      : 'none',
                  transform: hoverQuick === 'ddd-062' ? 'translateY(-1px)' : 'none',
                  transition: 'box-shadow 120ms ease, transform 120ms ease',
                }}
              >
                062
              </button>
            </div>
          </div>
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
          <h4 style={{ marginTop: 0, marginBottom: 10 }}>Endereço</h4>

          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              flexWrap: 'wrap',
              marginBottom: 6,
            }}
          >
            <span style={labelStyle}>Cidade</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    cidade: 'Itumbiara',
                    cidadeLivre: '',
                  }))
                }
                onMouseEnter={() => setHoverQuick('cidade-itumbiara')}
                onMouseLeave={() => setHoverQuick(null)}
                style={{
                  padding: '6px 10px',
                  borderRadius: 999,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-main)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  boxShadow:
                    hoverQuick === 'cidade-itumbiara'
                      ? '0 6px 16px rgba(37, 99, 235, 0.25)'
                      : 'none',
                  transform:
                    hoverQuick === 'cidade-itumbiara' ? 'translateY(-1px)' : 'none',
                  transition: 'box-shadow 120ms ease, transform 120ms ease',
                }}
              >
                Itumbiara
              </button>
              <button
                type="button"
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    cidade: 'Araporã',
                    cidadeLivre: '',
                  }))
                }
                onMouseEnter={() => setHoverQuick('cidade-arapora')}
                onMouseLeave={() => setHoverQuick(null)}
                style={{
                  padding: '6px 10px',
                  borderRadius: 999,
                  border: '1px solid var(--border-soft)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-main)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  boxShadow:
                    hoverQuick === 'cidade-arapora'
                      ? '0 6px 16px rgba(37, 99, 235, 0.25)'
                      : 'none',
                  transform:
                    hoverQuick === 'cidade-arapora' ? 'translateY(-1px)' : 'none',
                  transition: 'box-shadow 120ms ease, transform 120ms ease',
                }}
              >
                Araporã
              </button>
            </div>
          </div>
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
            Mora em prédio
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
          <h4 style={{ marginTop: 0, marginBottom: 10 }}>Trabalho</h4>

          <input
            name="empresa"
            value={form.empresa}
            onChange={handleChange}
            placeholder="Nome da empresa"
            style={fieldStyle}
          />
          <input
            name="categoriaTrabalho"
            value={form.categoriaTrabalho}
            onChange={handleChange}
            placeholder="Categoria de trabalho"
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
            name="ruaEmpresa"
            value={form.ruaEmpresa}
            onChange={handleChange}
            placeholder="Rua da empresa"
            style={{ ...fieldStyle, marginTop: 8 }}
          />
          <input
            name="numeroEmpresa"
            value={form.numeroEmpresa}
            onChange={handleChange}
            placeholder="Número da empresa"
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
          <h4 style={{ marginTop: 0, marginBottom: 10 }}>Extras</h4>

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
          <h4 style={{ marginTop: 0, marginBottom: 10 }}>Data de Cadastro</h4>
          <input
            name="criadoEm"
            type="date"
            value={form.criadoEm}
            onChange={handleChange}
            style={fieldStyle}
          />
        </div>

        <div style={{ marginTop: 20 }}>
          <button
            onClick={salvar}
            style={primaryButtonStyle}
            disabled={salvando || processandoFoto}
          >
            {processandoFoto
              ? 'Preparando foto...'
              : salvando
                ? 'Salvando...'
                : 'Cadastrar Cliente'}
          </button>
        </div>
      </div>
    </div>
  );
}
