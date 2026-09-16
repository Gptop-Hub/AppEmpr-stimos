const digitos = value => String(value ?? '').replace(/\D/g, '');

export function normalizarDDD(value) {
  const ddd = digitos(value);
  return /^0\d{2}$/.test(ddd) ? ddd.slice(1) : ddd;
}

export function normalizarTelefoneCliente(value) {
  let numero = digitos(value);
  if (/^\s*\+55/.test(String(value)) || (/^55/.test(numero) && [12,13].includes(numero.length))) {
    numero = numero.slice(2);
  }
  if (numero.startsWith('0') && [11,12].includes(numero.length)) numero = numero.slice(1);
  return /^[1-9]\d{9,10}$/.test(numero) ? numero : '';
}

export function mascararNumeroTelefone(value) {
  const numero = digitos(value).slice(0, 9);
  if (numero.length <= 4) return numero;
  const tamanhoPrefixo = numero.length === 9 ? 5 : 4;
  return `${numero.slice(0, tamanhoPrefixo)}-${numero.slice(tamanhoPrefixo)}`;
}

export function separarTelefoneCliente(value) {
  const numero = normalizarTelefoneCliente(value);
  return numero
    ? { ddd: numero.slice(0,2), telefone: mascararNumeroTelefone(numero.slice(2)) }
    : { ddd: '', telefone: mascararNumeroTelefone(value) };
}

export function dataClienteParaInput(value) {
  return String(value ?? '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '';
}

const normalizarNome = value => String(value ?? '').trim().replace(/\s+/g, ' ')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function camposAlterados(form, inicial, campos) {
  return campos.some(campo => form[campo] !== inicial?.[campo]);
}

export function camposDeIdentificacaoAlterados(dados, cliente) {
  return normalizarNome(dados.nome) !== normalizarNome(cliente.nome)
    || normalizarTelefoneCliente(dados.telefone) !== normalizarTelefoneCliente(cliente.telefone);
}

// Compartilhar telefone ou nome é permitido. Estes resultados servem para
// conferência, enquanto ID e CPF mantêm sua validação de unicidade própria.
export function encontrarDuplicidadesEdicao(dados, cliente, catalogo) {
  const outros = catalogo.filter(item => Number(item.id) !== Number(cliente.id));
  const avisos = [];
  const nome = normalizarNome(dados.nome);
  const telefone = normalizarTelefoneCliente(dados.telefone);
  if (nome && nome !== normalizarNome(cliente.nome)) {
    const encontrados = outros.filter(item => normalizarNome(item.nome) === nome);
    if (encontrados.length) avisos.push({ campo: 'nome', valor: dados.nome.trim(), clientes: encontrados });
  }
  if (telefone && telefone !== normalizarTelefoneCliente(cliente.telefone)) {
    const encontrados = outros.filter(item => [item.telefone, ...(item.telefones_extras || []), ...(item.telefones || [])]
      .some(value => normalizarTelefoneCliente(value) === telefone));
    if (encontrados.length) avisos.push({ campo: 'telefone', valor: dados.telefone, clientes: encontrados });
  }
  return avisos;
}

export function mensagemDuplicidade(aviso) {
  const clientes = aviso.clientes.map(item => `#${item.id} — ${item.nome}`).join('; ');
  return `${aviso.campo === 'telefone' ? 'Este telefone também está cadastrado' : 'Este nome completo também está cadastrado'} em: ${clientes}.`;
}
