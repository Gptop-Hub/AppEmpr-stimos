# [Relatorios] PR-XX - <titulo curto>

Template padrao para PRs do modulo Relatorios.
Uso recomendado:
- GitHub: copiar para `.github/PULL_REQUEST_TEMPLATE/relatorios.md`
- GitLab: copiar para `.gitlab/merge_request_templates/Relatorios.md`

## Identificacao
- Fase: `PR-01 | PR-02 | PR-03 | PR-04 | PR-05 | PR-06 | PR-07`
- Issue/Ticket:
- Responsavel:
- Revisor(es):
- Data:

## Gate obrigatorio de merge
- [ ] Impacto no legado preenchido
- [ ] Endpoints criados/alterados preenchido
- [ ] Migracoes preenchido (ou `N/A` com justificativa)
- [ ] Rollback preenchido
- [ ] Evidencias de teste anexadas

## 1) Objetivo
Descreva o objetivo tecnico em 3-5 linhas.

## 2) Escopo
### Inclui
- [ ] Item 1
- [ ] Item 2
- [ ] Item 3

### Nao inclui
- [ ] Item 1
- [ ] Item 2

## 3) Tarefas tecnicas executadas
- [ ] Backend
- [ ] Frontend
- [ ] Query/DB
- [ ] Documentacao
- [ ] Compatibilidade com legado

## 4) Impacto no legado (OBRIGATORIO)
- Fluxos legados impactados:
- Fluxos legados preservados:
- Compatibilidade temporaria aplicada:
- Plano de descontinuacao do legado (se houver):
- Risco de regressao legado: `baixo | medio | alto`

## 5) Endpoints criados/alterados (OBRIGATORIO)
| Metodo | Endpoint | Tipo (`novo|alterado|legado-adapter`) | Contrato alterado (`sim|nao`) | Compatibilidade legado (`sim|nao`) | Observacoes |
|---|---|---|---|---|---|
| GET | /relatorios/... | novo | nao | sim | |

## 6) Migracoes (OBRIGATORIO quando aplicavel)
- Ha migracao neste PR? `sim | nao`
- Arquivo(s):
- Idempotente: `sim | nao`
- Ordem de execucao:
- Tempo estimado:
- Impacto esperado:
- Plano de rollback de schema:
- Se nao houver migracao, justificar:

## 7) Rollback (OBRIGATORIO)
- Condicoes para acionar rollback:
- Passo 1:
- Passo 2:
- Passo 3:
- Efeito esperado apos rollback:
- Dados irreversiveis envolvidos: `sim | nao`
- Se sim, detalhar:

## 8) Evidencias de teste (OBRIGATORIO)
### Testes automatizados
- Comandos executados:
- Resultado:
- Evidencia (log/link):

### Testes manuais
- Cenario 1:
- Passos:
- Resultado:
- Evidencia:
- Cenario 2:
- Passos:
- Resultado:
- Evidencia:

## 9) Checklist QA comum (todos os PRs)
- [ ] API sobe sem erro
- [ ] Endpoints legados criticos seguem funcionando
- [ ] Sem quebra de contrato JSON no legado
- [ ] Timezone validado em filtros e atraso
- [ ] Status HTTP de erro coerente
- [ ] Rollback descrito e executavel
- [ ] Evidencias anexadas

## 10) Checklist QA por fase (marcar apenas a fase deste PR)
### PR-01 - Fundacao backend
- [ ] Rota `/relatorios` registrada e acessivel
- [ ] `/relatorio/caixa/resumo` sem regressao
- [ ] `/relatorio/caixa/linhas` sem regressao
- [ ] Migracao de indices executa em base antiga
- [ ] Migracao de indices idempotente (2a execucao sem erro)

### PR-02 - Backend cobranca + impressao (API)
- [ ] `/relatorios/cobranca` retorna campos operacionais completos
- [ ] Ordenacao padrao operacional aplicada (`dias_em_atraso DESC`, `vencimento ASC`)
- [ ] Filtros por periodo/status/cliente funcionando
- [ ] `/relatorios/cobranca/print` retorna dataset completo
- [ ] Regras de parcela aberta/paga consistentes

### PR-03 - Frontend cobranca + impressao
- [ ] Aba Cobranca funcional ponta a ponta
- [ ] Colunas operacionais legiveis: telefone, vencimento, valor, atraso, observacoes
- [ ] Impressao validada em multiplas paginas (A4)
- [ ] Cabecalho de tabela repete por pagina na impressao
- [ ] Layout de papel util para anotacao manual

### PR-04 - Backend recebimentos + fluxo de caixa
- [ ] Recebimentos separado de Fluxo de Caixa no contrato e na regra
- [ ] Totais de recebimentos consistentes com fluxo atual
- [ ] Split capital/juros consistente com dados existentes
- [ ] Endpoints legados mantidos sem quebra

### PR-05 - Frontend recebimentos + fluxo de caixa
- [ ] Aba Recebimentos nao mistura conceitos de caixa
- [ ] Aba Fluxo de Caixa mostra entradas, saidas e saldo corretamente
- [ ] Rota legada `/fluxo-caixa` continua funcionando
- [ ] Acoes existentes (sincronizar historico, despesa) seguem operacionais

### PR-06 - Backend inadimplencia + carteira
- [ ] Faixas de atraso `1-7`, `8-30`, `31+` corretas
- [ ] Soma das faixas bate com total em atraso
- [ ] Definicoes operacionais de `ativo`, `quitado`, `renegociado` documentadas no contrato
- [ ] Performance aceitavel em base de referencia

### PR-07 - Frontend inadimplencia + carteira + fechamento
- [ ] Abas Inadimplencia e Carteira funcionais
- [ ] Definicoes operacionais exibidas ao usuario
- [ ] Navegacao entre 5 abas sem regressao
- [ ] Fluxo legado continua acessivel durante transicao

## 11) Pontos de regressao para conferir
- [ ] Rotas legadas de relatorio continuam estaveis
- [ ] Filtros de periodo mantem comportamento esperado
- [ ] Ordenacao operacional de cobranca nao regrediu
- [ ] Impressao multipagina continua legivel
- [ ] Consistencia entre Recebimentos e Fluxo de Caixa continua valida
- [ ] Definicoes de Carteira nao mudaram sem revisao

## 12) Dependencias entre PRs
- PRs dos quais este depende:
- PRs bloqueados por este:
- Ordem de merge confirmada:

## 13) Definition of Done (DoD)
- [ ] Escopo tecnico concluido
- [ ] Dependencias de PR respeitadas
- [ ] Checklist QA comum concluido
- [ ] Checklist QA da fase concluido
- [ ] Regressao critica validada
- [ ] Impacto no legado documentado
- [ ] Endpoints criados/alterados documentados
- [ ] Migracoes validadas (ou N/A justificado)
- [ ] Rollback documentado e executavel
- [ ] Evidencias de teste anexadas

## 14) Observacoes finais
Registre decisoes tecnicas, tradeoffs e follow-ups (se houver).

