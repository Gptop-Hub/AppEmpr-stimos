# Gerenciador central de segurança — relatório

Workspace confirmado antes do trabalho: `C:\Projetos\Sistema de emprestimos`.

## 1. Auditoria e migração dos oito fluxos

Há uma diferença entre a auditoria informada e o código encontrado: editar cliente não exigia senha. A proteção foi acrescentada conforme a intenção expressa no pedido, inicializada com a mesma senha legada conhecida da exclusão de cliente. Nenhuma senha desconhecida foi inventada.

| Chave | Validação anterior encontrada | Endpoint protegido agora | ON correta / ON errada / OFF |
| --- | --- | --- | --- |
| editar_cliente | Não havia validação | PUT /clientes/:id | Permitido / bloqueado / permitido sem senha |
| excluir_cliente | Comparação fixa no frontend | DELETE /clientes/:id | Permitido / bloqueado / permitido sem senha |
| editar_emprestimo | Comparação fixa no frontend | PUT /emprestimos/:id | Permitido / bloqueado / permitido sem senha |
| excluir_emprestimo | ADMIN_PASSWORD ou padrão no controlador | DELETE /emprestimos/:id | Permitido / bloqueado / permitido sem senha |
| excluir_todos_emprestimos | ADMIN_PASSWORD ou padrão no controlador | POST /emprestimos/reset-all | Permitido / bloqueado / permitido sem senha |
| adicionar_juros_parcela | Comparação fixa no frontend, apenas quando não era a parcela atual | POST /parcelas/:id/juros-adicionais; PUT alternativo se enviar juros_adicionais | Permitido / bloqueado / permitido sem senha |
| excluir_despesa | ADMIN_PASSWORD ou padrão na rota | DELETE /caixa/despesa/:id | Permitido / bloqueado / permitido sem senha |
| apagar_todos_dados | ADMIN_PASSWORD ou padrão na rota | POST /sistema/excluir-tudo | Permitido / bloqueado / permitido sem senha |

As comparações fixas dos componentes usavam `1otimodia`. Os quatro consumidores administrativos usavam `process.env.ADMIN_PASSWORD || '1otimodia'`. A inicialização migra exatamente essas origens para hashes distintos, com salts aleatórios. Inicialmente os oito itens ficam ligados. As senhas podem ter o mesmo valor inicial por compatibilidade, mas alterar uma não altera nem autoriza outra proteção.

Somente linhas ausentes são inicializadas: reiniciar não substitui senhas ou estados já configurados. Uma senha administrativa legada inválida interrompe a inicialização antes de inserir as oito linhas, com orientação para corrigir ADMIN_PASSWORD. A fábrica também suporta inicialização explícita sem senha conhecida, usada nos testes: o item permanece desligado e exige definição de senha antes de ligar.

## 2. Arquivos desta tarefa

Criados:

- backend/services/segurancaService.js
- backend/middleware/protecao.js
- backend/routes/seguranca.js
- frontend/src/security/segurancaCore.js
- frontend/src/security/seguranca.js
- frontend/src/security/GerenciadorSeguranca.jsx
- frontend/src/security/ProtecaoItem.jsx
- frontend/src/security/seguranca.css
- backend/tests/seguranca.test.js
- frontend/tests/segurancaCore.test.js
- frontend/tests/segurancaInterface.test.js
- docs/gerenciador-seguranca.md

Alterados para integrar a camada:

- backend/index.js e backend/utils/paths.js
- backend/routes/cliente.js, emprestimo.js, parcelas.js, caixa.js e sistema.js
- backend/controllers/emprestimosController.js: somente substituição das duas checagens antigas por middleware nas rotas
- backend/services/systemPurgeService.js: preservação do banco de configurações de segurança
- frontend/src/App.jsx e frontend/src/componentes/menu.jsx: acesso por escudo próximo ao controle de tema
- frontend/src/componentes/clientes.jsx, editarcliente.jsx, editaremprestimo.jsx, fluxoCaixa.jsx e dashboard.jsx
- frontend/src/componentes/Emprestimos/index.jsx, ParcelaList.jsx e JurosAdicionaisModal.jsx
- backend/tests/clienteEdicao.test.js, systemPurgeService.test.js e backupFotosIntegration.test.js

As alterações anteriores do workspace foram preservadas. Nenhuma dependência foi acrescentada: sqlite3 já existia, e o hashing usa crypto nativo do Node.

## 3. Persistência e schema

`seguranca.db` fica ao lado de `database.db`, no diretório de dados resolvido pelo aplicativo. É um SQLite separado do banco financeiro.

```sql
CREATE TABLE IF NOT EXISTS seguranca_protecoes (
  chave TEXT PRIMARY KEY,
  ativo INTEGER NOT NULL CHECK(ativo IN (0,1)),
  senha_hash TEXT,
  revisao INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  CHECK(ativo = 0 OR senha_hash IS NOT NULL)
);
```

`revisao` invalida autorizações anteriores e evita sobrescrever alterações simultâneas de outra janela. Os timestamps usam ISO. Estados e hashes não ficam no localStorage nem no sessionStorage.

Restaurar um backup financeiro não restaura senhas antigas. Apagar os dados financeiros preserva o banco de segurança e seus arquivos auxiliares: as proteções não voltam silenciosamente aos padrões. Essa preservação foi testada usando arquivos temporários; a restauração foi testada com duas instâncias reais do backend e diretórios temporários.

## 4. API/camada central

No backend, `protecaoAtiva(chave)` lê o estado persistido. `validarSenhaProtecao(chave, senha)` verifica o hash específico e emite um token opaco, aleatório, válido por dois minutos, restrito à chave e à revisão atual. Tokens ficam somente na memória e não sobrevivem ao reinício.

No frontend, `autorizarProtecao(chave, contexto)` consulta o backend a cada ação. OFF retorna uma configuração de requisição vazia, sem abrir prompt nem validar senha. ON abre o prompt comum, valida a senha e retorna o cabeçalho `X-Protecao-Token`. Cancelamento, senha errada ou indisponibilidade retornam cancelamento da operação.

Cada endpoint protegido verifica novamente o estado no backend: não basta esconder o prompt. Sem autorização válida, ON responde 401 antes do executor. Falha de segurança responde 503 e bloqueia a operação. Alterações de senha/estado invalidam tokens anteriores.

Endpoints de configuração:

- GET /seguranca/protecoes — catálogo completo, apenas metadados
- GET /seguranca/protecoes/:chave — estado; para juros aceita parcelaId e retorna também exigida
- POST /seguranca/protecoes/:chave/validar — valida senha e emite token
- PUT /seguranca/protecoes/:chave/senha — define/altera senha
- PUT /seguranca/protecoes/:chave/estado — ativa/desativa

As respostas usam Cache-Control: no-store. Hashes nunca são retornados. Por compatibilidade, operações ainda aceitam `body.password`, mas o valor é validado contra o hash da proteção correspondente, sem fallback administrativo após a migração. O middleware remove esse campo antes de chegar aos logs/controladores.

## 5. Hash e controles

Scrypt com N=32768, r=8 e p=3; salt aleatório de 16 bytes; derivação de 64 bytes; comparação com timingSafeEqual. O hash inclui algoritmo, parâmetros e salt. Há limite de oito tentativas em uma janela de um minuto por proteção, incluindo chamadas paralelas. A janela não é um bloqueio permanente.

Senhas novas precisam ser não vazias e ter no máximo 1024 bytes; a confirmação deve ser idêntica. Espaços não são removidos da senha efetiva. Não há armazenamento de senha digitada em disco ou nas configurações do navegador.

## 6. Definir, alterar e alternar

- Sem senha: Definir senha solicita nova senha e confirmação. Ligar sem senha primeiro abre esse formulário; só liga após definição bem-sucedida.
- Com senha: Alterar senha exige senha atual, nova senha e confirmação. Erros não alteram hash nem estado.
- Ligar com senha existente: ativa sem exigir senha novamente, como solicitado.
- Desligar: exige senha atual daquela própria proteção. Senha errada mantém ON. Tokens de operação não substituem a senha atual nessa mudança.
- O switch desliza para Ligado à esquerda ou Desligado à direita; a palavra ativa fica verde ou vermelha, e a inativa cinza/apagada.
- Confirmações comuns de exclusão e a frase EXCLUIR TUDO continuam existindo mesmo OFF.

Para juros, a decisão sobre a parcela atual é feita no backend usando os mesmos critérios de seleção existentes: versão atual ou nula, número diferente de -1, não paga e sem valor pago, em ordem de número. Juros na parcela atual continuam sem essa senha. O PUT genérico não permite contornar a proteção enviando juros_adicionais de uma parcela futura; alterar apenas vencimento não recebe nova exigência.

## 7. Login desativado

Permanece em frontend/src/App.jsx: APP_ACCESS_PASSWORD, isUnlocked inicializado como true, estados da senha de acesso, handleUnlockSubmit e JSX de entrada em `if (!isUnlocked)`. Esse código não foi apagado, reativado, refatorado nem integrado ao gerenciador. App.jsx recebeu apenas o acesso ao novo modal e seu estado separado.

## 8. Testes e build

Bateria direcionada: 56 testes passaram, incluindo os oito cenários ON correto / ON errado / OFF nos helpers do frontend e nas rotas reais com executores substituídos por spies; renderização dos oito itens e formulários; persistência ao reabrir SQLite; independência das senhas; invalidação/expiração dos tokens; tentativas erradas paralelas; definir e alterar senha; confirmação divergente; ligar sem senha; desligar com senha errada; migração administrativa; bloqueio de migração inválida; indisponibilidade; juros atuais/futuros e PUT alternativo; confirmação da frase; preservação em purge e restore; regressões de edição de cliente e backups/fotos.

Comando reproduzível:

```powershell
node --test backend/tests/seguranca.test.js frontend/tests/segurancaCore.test.js frontend/tests/segurancaInterface.test.js backend/tests/systemPurgeService.test.js backend/tests/clienteEdicao.test.js frontend/tests/clienteEdicaoUtils.test.js backend/tests/backupFotosIntegration.test.js backend/tests/backupBundleService.test.js
npm.cmd run build:renderer
```

Build do renderer aprovado. Nenhuma exclusão ou alteração foi testada contra o banco real. Os testes removem apenas seus próprios diretórios temporários.

## 9. Limitações e escopo

- A interface foi validada por renderização de componentes, testes do helper e build; não houve teste visual interativo do Electron.
- Não foi executada a suíte completa do projeto. Os resultados acima são da bateria direcionada, não uma afirmação sobre todos os testes existentes.
- A proteção editar_cliente cobre o salvamento do formulário principal. Ações auxiliares independentes, como foto pelo card, telefones adicionais e marcações por PATCH, não receberam novas exigências fora dos oito pontos definidos.
- Isso não é autenticação global nem proteção contra alguém com acesso direto aos arquivos do computador. O login continua desativado e as outras ações não foram transformadas em um sistema de permissões.
- Backups financeiros não transferem as configurações de segurança para outro computador. O destino mantém suas próprias senhas/estados.
- Não foi acrescentado mecanismo de recuperação de senha esquecida; alterar/desligar exige conhecer a senha atual. Não se deve apagar seguranca.db como rotina de recuperação, pois isso restauraria padrões na inicialização.
- A senha inicial compartilhada é preservada apenas por compatibilidade; o gerenciador permite substituí-la independentemente em cada item.
- Nenhuma regra financeira, cálculo, versão ou publicação foi alterada. Não houve commit nem push.
