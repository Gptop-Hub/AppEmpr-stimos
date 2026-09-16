import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { autorizarProtecao } from '../security/seguranca.js';
import notify from '../ui/notify';
import {
  CLIENT_PHOTO_ACCEPT,
  formatarTamanhoFoto,
  prepararFotoCliente,
} from './common/clientePhotoProcessing';
import ClientePhotoZoom from './common/ClientePhotoZoom.jsx';
import { atualizarClienteNoCatalogo } from './common/useClientesCatalogo.js';
import {
  normalizarDDD, normalizarTelefoneCliente, mascararNumeroTelefone, separarTelefoneCliente,
  dataClienteParaInput, camposAlterados, camposDeIdentificacaoAlterados,
  encontrarDuplicidadesEdicao, mensagemDuplicidade,
} from './common/clienteEdicaoUtils.js';

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

export default function EditarCliente({ cliente, clientesExistentes = [], onCancel, onSalvo }) {
  const [form, setForm] = useState({
    id: '', nome: '', cpf: '', ddd: '', telefone: '',
    cidade: '', cidadeLivre: '', bairro: '', rua: '', numero: '',
    emPredio: false, nomePredio: '', andar: '', flat: '',
    empresa: '', categoriaTrabalho: '', ruaEmpresa: '', bairroEmpresa: '', funcao: '', telEmpresa: '',
    referencia: '', observacao: '', criadoEm: '',
    receberNotificacoesCobranca: true, motivoNotificacoesCobranca: ''
  });

  const [cpfExiste, setCpfExiste] = useState(false);
  const [fotoArquivo, setFotoArquivo] = useState(null);
  const [fotoPreview, setFotoPreview] = useState('');
  const [fotoNomeOriginal, setFotoNomeOriginal] = useState('');
  const [processandoFoto, setProcessandoFoto] = useState(false);
  const [removerFotoAtual, setRemoverFotoAtual] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const fotoInputRef = useRef(null);
  const formInicialRef = useRef(null);
  const telefoneFormulario = `(${normalizarDDD(form.ddd)}) ${form.telefone}`;
  const avisosDuplicidade = encontrarDuplicidadesEdicao(
    { nome: form.nome, telefone: telefoneFormulario }, cliente, clientesExistentes
  );

  useEffect(
    () => () => {
      if (fotoPreview) URL.revokeObjectURL(fotoPreview);
    },
    [fotoPreview]
  );

  // Preenche o formulário com dados existentes, aplicando máscaras
  useEffect(() => {
    if (!cliente) return;

    const { ddd, telefone } = separarTelefoneCliente(cliente.telefone);

    const dados = {
      id: String(cliente.id),
      nome: cliente.nome || '',
      cpf: maskCPF(cliente.cpf || ''),
      ddd,
      telefone,
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
      categoriaTrabalho: cliente.categoria_trabalho || extrairCampo(cliente.trabalho, 'Categoria') || extrairCampo(cliente.trabalho, 'categoria') || '',
      ruaEmpresa: extrairCampo(cliente.trabalho, 'Rua') || extrairCampo(cliente.trabalho, 'rua') || '',
      bairroEmpresa: extrairCampo(cliente.trabalho, 'Bairro') || extrairCampo(cliente.trabalho, 'bairro') || '',
      funcao: extrairCampo(cliente.trabalho, 'Função') || extrairCampo(cliente.trabalho, 'função') || '',
      telEmpresa: extrairCampo(cliente.trabalho, 'Telefone') || extrairCampo(cliente.trabalho, 'telefone') || '',

      referencia: cliente.referencia || '',
      observacao: cliente.observacao || '',
      criadoEm: dataClienteParaInput(cliente.criadoEm),
      receberNotificacoesCobranca:
        Number(cliente.receber_notificacoes_cobranca ?? 1) === 1,
      motivoNotificacoesCobranca: cliente.motivo_notificacoes_cobranca || ''
    };

    formInicialRef.current = dados;
    setForm(dados);
    setCpfExiste(false);
    setFotoArquivo(null);
    setFotoPreview('');
    setFotoNomeOriginal('');
    setRemoverFotoAtual(false);
  }, [cliente]);

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
      setRemoverFotoAtual(false);
    } catch (err) {
      notify.error(err?.message || 'Não foi possível preparar a foto.');
    } finally {
      setProcessandoFoto(false);
    }
  };

  const removerFoto = () => {
    setFotoArquivo(null);
    setFotoPreview('');
    setFotoNomeOriginal('');
    setRemoverFotoAtual(Boolean(cliente?.foto_cliente));
  };

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
      const res = await axios.get('/clientes/check-cpf', { params: { cpf: cpfClean } });
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
    const d = normalizarDDD(e.target.value).slice(0, 2);
    setForm((prev) => ({ ...prev, ddd: d }));
  };

  const onChangeTelefone = (e) => {
    setForm((prev) => ({ ...prev, telefone: mascararNumeroTelefone(e.target.value) }));
  };

  const handleSalvar = async () => {
    if (salvando || processandoFoto) return;
    const novoId = Number(form.id);
    if (!/^\d+$/.test(form.id.trim()) || !Number.isSafeInteger(novoId) || novoId <= 0) {
      notify.warn('Informe um ID inteiro positivo válido.');
      return;
    }
    // validações simples
    if (!form.nome.trim() || !soDigitos(form.cpf) || !form.ddd || !soDigitos(form.telefone)) {
      notify.warn('Preencha Nome, CPF, DDD e Telefone.');
      return;
    }
    if (soDigitos(form.cpf).length !== 11) {
      notify.warn('CPF deve ter 11 dígitos.');
      return;
    }
    if (!/^[1-9]\d$/.test(normalizarDDD(form.ddd))) {
      notify.warn('DDD deve ter 2 dígitos.');
      return;
    }
    if (![8,9].includes(soDigitos(form.telefone).length)) {
      notify.warn('Telefone deve ter 8 ou 9 dígitos, além do DDD.');
      return;
    }
    if (!form.criadoEm) {
      notify.warn('Preencha a data em Cliente desde.');
      return;
    }
    if (cpfExiste) {
      notify.error('CPF já cadastrado para outro cliente.');
      return;
    }

    const nome = form.nome === formInicialRef.current?.nome ? cliente.nome : capitalizeNome(form.nome);
    const cidadeFinal = form.cidade === 'Outra' ? form.cidadeLivre : form.cidade;

    let endereco = `Rua: ${form.rua}, Nº: ${form.numero}, Bairro: ${form.bairro}, Cidade: ${cidadeFinal}`;
    if (form.emPredio) {
      endereco += `, Prédio: ${form.nomePredio}, Andar: ${form.andar}, Flat: ${form.flat}`;
    }
    if (!camposAlterados(form, formInicialRef.current, ['cidade','cidadeLivre','bairro','rua','numero','emPredio','nomePredio','andar','flat'])) {
      endereco = cliente.endereco || '';
    }

    let trabalho = `Empresa: ${form.empresa}, Categoria: ${form.categoriaTrabalho}, Rua: ${form.ruaEmpresa}, Bairro: ${form.bairroEmpresa}, Função: ${form.funcao}, Telefone: ${form.telEmpresa}`;
    if (!camposAlterados(form, formInicialRef.current, ['empresa','categoriaTrabalho','ruaEmpresa','bairroEmpresa','funcao','telEmpresa'])) {
      trabalho = cliente.trabalho || '';
    }
    const telefone = normalizarTelefoneCliente(telefoneFormulario) === normalizarTelefoneCliente(cliente.telefone)
      ? cliente.telefone : telefoneFormulario;
    const payload = {
      id: novoId,
      nome,
      cpf: soDigitos(form.cpf),        // envia apenas dígitos, igual NovoCliente
      telefone,
      endereco,
      trabalho,
      categoria_trabalho: form.categoriaTrabalho === formInicialRef.current?.categoriaTrabalho
        ? cliente.categoria_trabalho || '' : form.categoriaTrabalho,
      referencia: form.referencia,
      observacao: form.observacao,
      criadoEm: form.criadoEm === formInicialRef.current?.criadoEm ? cliente.criadoEm : form.criadoEm,
      receber_notificacoes_cobranca: form.receberNotificacoesCobranca,
      motivo_notificacoes_cobranca: form.motivoNotificacoesCobranca
    };

    if (processandoFoto) {
      notify.warn('Aguarde a foto terminar de ser preparada.');
      return;
    }
    if (salvando) return;
    setSalvando(true);

    try {
      if (novoId !== Number(cliente.id)) {
        const disponibilidade = await axios.get(`/clientes/check-id/${novoId}`);
        if (disponibilidade.data.exists) {
          notify.error(`Já existe um cliente com o ID ${novoId}.`);
          return;
        }
      }
      const dadosIdentificacao = { nome, telefone };
      if (camposDeIdentificacaoAlterados(dadosIdentificacao, cliente)) {
        const catalogo = await axios.get('/clientes');
        const avisos = encontrarDuplicidadesEdicao(dadosIdentificacao, cliente, catalogo.data);
        if (avisos.length) {
          const confirmado = await notify.confirm(
            `${avisos.map(mensagemDuplicidade).join('\n\n')}\n\nSe os dados estiverem corretos, você pode salvar mesmo assim. Deseja continuar?`,
            { title: 'Conferir dados repetidos', okText: 'Salvar mesmo assim', cancelText: 'Revisar' }
          );
          if (!confirmado) return;
        }
      }
      const autorizacao = await autorizarProtecao('editar_cliente');
      if (!autorizacao) return;
      const res = await axios.put(`/clientes/${cliente.id}`, payload, autorizacao);
      const idSalvo = res.data.id;
      atualizarClienteNoCatalogo(res.data, cliente.id);

      try {
        if (fotoArquivo) {
          const fotoData = new FormData();
          fotoData.append('foto', fotoArquivo);
          const fotoSalva = await axios.post(
            `/clientes/${idSalvo}/foto`,
            fotoData
          );
          atualizarClienteNoCatalogo(fotoSalva.data);
        } else if (removerFotoAtual && cliente?.foto_cliente) {
          const fotoRemovida = await axios.delete(`/clientes/${idSalvo}/foto`);
          atualizarClienteNoCatalogo(fotoRemovida.data);
        }
      } catch (fotoErr) {
        console.error('Dados atualizados, mas houve erro ao salvar a foto:', fotoErr);
        notify.warn(
          'Os dados do cliente foram salvos, mas não foi possível atualizar a foto.'
        );
        onSalvo && onSalvo();
        return;
      }

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
      notify.error(err.response?.data?.error || 'Erro ao editar cliente.');
    } finally {
      setSalvando(false);
    }
  };

  const bloco = { marginBottom: 20, paddingBottom: 10, borderBottom: '1px solid #ccc' };
  const label = { display: 'block', marginTop: 8 };

  return (
    <div style={{ padding: 20, maxWidth: 600, margin: '0 auto' }}>
      <h3>Editar Cliente</h3>

      <div style={bloco}>
        <div className="cliente-photo-field">
          <ClientePhotoZoom
            cliente={cliente}
            nome={form.nome}
            src={fotoPreview || (removerFotoAtual ? '' : undefined)}
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
                  : fotoArquivo || (cliente?.foto_cliente && !removerFotoAtual)
                    ? 'Trocar foto'
                    : 'Selecionar foto'}
              </button>
              {fotoArquivo || (cliente?.foto_cliente && !removerFotoAtual) ? (
                <button
                  type="button"
                  className="cliente-photo-button cliente-photo-button--danger"
                  onClick={removerFoto}
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
                : removerFotoAtual
                  ? 'A foto atual será removida ao salvar.'
                  : 'Selecione uma imagem; fotos grandes serão otimizadas.'}
            </p>
          </div>
        </div>
      </div>

      {/* Dados Pessoais */}
      <div style={bloco}>
        <h4>Dados Pessoais</h4>

        <label style={label}>ID do cliente</label>
        <input name="id" value={form.id} onChange={onChange} inputMode="numeric" />

        <label style={label}>Nome</label>
        <input name="nome" value={form.nome} onChange={onChange} />
        {avisosDuplicidade.filter(aviso => aviso.campo === 'nome').map(aviso => (
          <p key={aviso.campo} role="status" style={{ color: 'var(--text-muted)', margin: '4px 0' }}>{mensagemDuplicidade(aviso)}</p>
        ))}

        <label style={label}>CPF</label>
        <input name="cpf" value={form.cpf} onChange={onChangeCPF} onBlur={onBlurCpf} />
        {cpfExiste && <div style={{ color: 'red', marginTop: 4 }}>CPF já cadastrado para outro cliente.</div>}

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
        {avisosDuplicidade.filter(aviso => aviso.campo === 'telefone').map(aviso => (
          <p key={aviso.campo} role="status" style={{ color: 'var(--text-muted)', margin: '4px 0' }}>{mensagemDuplicidade(aviso)}</p>
        ))}
      </div>

      {/* Endereço */}
      <div style={bloco}>
        <h4>Endereço</h4>
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
          <input type="checkbox" name="emPredio" checked={form.emPredio} onChange={onChange} /> Mora em prédio
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
        <h4>Trabalho</h4>
        <label style={label}>Empresa</label>
        <input name="empresa" value={form.empresa} onChange={onChange} placeholder="Empresa" />
        <label style={label}>Categoria de trabalho</label>
        <input name="categoriaTrabalho" value={form.categoriaTrabalho} onChange={onChange} placeholder="Categoria de trabalho" />
        <label style={label}>Rua da empresa</label>
        <input name="ruaEmpresa" value={form.ruaEmpresa} onChange={onChange} placeholder="Rua da empresa" />
        <label style={label}>Bairro da empresa</label>
        <input name="bairroEmpresa" value={form.bairroEmpresa} onChange={onChange} placeholder="Bairro da empresa" />
        <label style={label}>Função</label>
        <input name="funcao" value={form.funcao} onChange={onChange} placeholder="Função" />
        <label style={label}>Telefone da empresa</label>
        <input name="telEmpresa" value={form.telEmpresa} onChange={onChange} placeholder="Telefone" />
      </div>

      {/* Extras */}
      <div style={bloco}>
        <h4>Extras</h4>
        <label style={label}>Referência</label>
        <input name="referencia" value={form.referencia} onChange={onChange} />

        <label style={label}>Observação</label>
        <textarea name="observacao" value={form.observacao} onChange={onChange} />
      </div>

      <div style={bloco}>
        <h4>Notificações de cobrança</h4>
        <p style={{ margin: '0 0 8px', color: 'var(--text-muted)', fontSize: 14 }}>
          Estado: {form.receberNotificacoesCobranca ? 'Ligadas' : 'Desligadas'}
        </p>
        <label style={label}>Motivo / observação</label>
        <textarea
          name="motivoNotificacoesCobranca"
          value={form.motivoNotificacoesCobranca}
          onChange={onChange}
          maxLength={2000}
          placeholder="Opcional. Não substitui a observação geral do cliente."
        />
        <p style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>
          Para ligar ou desligar notificações, use o menu de ações do cliente.
        </p>
      </div>

      {/* Data */}
      <div style={bloco}>
        <h4>Cliente desde</h4>
        <input type="date" name="criadoEm" value={form.criadoEm} onChange={onChange} />
      </div>

      <div style={{ marginTop: 20, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} disabled={salvando || processandoFoto}>Cancelar</button>
        <button onClick={handleSalvar} disabled={salvando || processandoFoto}>
          {processandoFoto
            ? 'Preparando foto...'
            : salvando
              ? 'Salvando...'
              : 'Salvar Alterações'}
        </button>
      </div>
    </div>
  );
}
