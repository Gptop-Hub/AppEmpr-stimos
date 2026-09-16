# Risk Log - Modulo Relatorios

Registro central de riscos para planejamento e execucao do modulo Relatorios.

## Convencoes
- Probabilidade: `B` (baixa), `M` (media), `A` (alta)
- Impacto: `B` (baixo), `M` (medio), `A` (alto)
- Status: `Aberto | Mitigando | Monitorando | Fechado | Aceito`
- Revisao minima: a cada PR da trilha de Relatorios

## Tabela de riscos
| ID | Fase | Risco | Gatilho/Indicador | Prob | Impacto | Mitigacao preventiva | Plano de contingencia | Dono | Status | Ultima revisao |
|---|---|---|---|---|---|---|---|---|---|---|
| R-01 | PR-01 | Regressao em endpoint legado `/relatorio/*` | Diferenca de payload, status HTTP ou erro em tela atual | M | A | Teste de contrato legado antes/depois | Reverter adapter legado e restaurar handler anterior |  | Aberto |  |
| R-02 | PR-01 | Migracao de indices causar lock/performance | Lentidao ou erro ao aplicar migracao em base antiga | B | M | Migracao idempotente e janela controlada | Rollback da release e desativacao temporaria da migracao |  | Aberto |  |
| R-03 | PR-02 | Regra de parcela aberta/paga inconsistente | Divergencia em cobranca entre telas e API | M | A | Reuso de regra unica defensiva para parcelas | Hotfix de regra e reprocessamento de consulta |  | Aberto |  |
| R-04 | PR-02 | Ordenacao operacional de cobranca inadequada | Lista nao prioriza atraso de forma util | M | M | Ordenar por `dias_em_atraso DESC` e `vencimento ASC` | Ajuste rapido de ORDER BY e republicacao |  | Aberto |  |
| R-05 | PR-03 | Impressao inutilizavel em multiplas paginas | Corte de linha, cabecalho ausente, truncamento | M | A | QA real em A4 com 1, 2 e 3+ paginas | Fallback para layout simplificado de impressao |  | Aberto |  |
| R-06 | PR-04 | Mistura conceitual Recebimentos vs Fluxo | Totais sem explicacao entre abas | M | A | Contratos e regras separados por dominio | Bloquear rollout da aba ate ajustar contratos |  | Aberto |  |
| R-07 | PR-04 | Divergencia de split capital/juros | Diferenca relevante vs fluxo atual | M | A | Fonte primaria consistente e tolerancia de arredondamento | Conciliacao e ajuste de query/split |  | Aberto |  |
| R-08 | PR-05 | Regressao em funcionalidades atuais de fluxo | Falha em sincronizar historico ou despesa | B | A | Testes manuais de regressao de fluxo atual | Reverter frontend da aba nova e manter tela antiga |  | Aberto |  |
| R-09 | PR-06 | Definicao ambigua de ativo/quitado/renegociado | KPI de carteira nao confiavel | M | A | Definicoes operacionais fixas no contrato | Patch de regra + comunicacao de mudanca |  | Aberto |  |
| R-10 | PR-06 | Query pesada em inadimplencia/carteira | Tempo de resposta alto em base maior | M | M | Indices e agregacoes revisadas | Limitar janela/paginacao e otimizar query |  | Aberto |  |
| R-11 | PR-07 | Navegacao final quebrar rotas legadas | Menu/rota antiga nao abre fluxo esperado | B | M | Manter alias e testes de navegacao cruzada | Restaurar alias anterior ate correcao |  | Aberto |  |
| R-12 | Todos | Evidencias de teste incompletas | PR sem prova objetiva de validacao | M | M | Gate obrigatorio no template de PR | Bloquear merge ate anexar evidencias |  | Aberto |  |

## Log de eventos de risco
| Data | ID risco | Evento observado | Acao executada | Resultado | Responsavel |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## Checklist de revisao de risco por PR
- [ ] Riscos da fase revisados
- [ ] Probabilidade/impacto atualizados
- [ ] Mitigacoes executadas confirmadas
- [ ] Planos de contingencia validos
- [ ] Novos riscos registrados (se houver)
- [ ] Riscos fechados justificados

## Regras de governanca
- Cada PR deve referenciar este arquivo na descricao.
- Toda alteracao de status deve registrar data e responsavel.
- Risco com impacto `A` nao pode ficar sem mitigacao definida.
- Merge deve ser bloqueado se houver risco critico sem dono.

