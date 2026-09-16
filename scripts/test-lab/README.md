# Laboratório de dados de teste (somente desenvolvimento)

Este diretório contém ferramentas manuais. O dataset canônico está em `C:\Projetos\DADOS-TESTE-EMPRESTIMOS\dataset-v1.json`. A cópia de trabalho gerada fica em `.test-lab/dataset-v1.json`. O arquivo externo é o artefato reutilizável pelo aplicativo celular; não é necessário para iniciar ou instalar o PC.

Na raiz `C:\Projetos\Sistema de emprestimos`, execute:

```powershell
npm.cmd run seed:test
npm.cmd run seed:test:clear
npm.cmd run seed:test:validate
```

Em um shell que permita `npm`, o mesmo funciona como `npm run seed:test`, `npm run seed:test:clear` e `npm run seed:test:validate`. O PowerShell deste ambiente bloqueia `npm.ps1`, daí o uso de `npm.cmd`.

O importador usa **exclusivamente** `.test-lab/app/emprestimos-data/database.db`. Para outro banco descartável dentro de `.test-lab`, use `npm.cmd run seed:test -- --db .test-lab/outro/database.db` e o mesmo argumento no comando de limpeza. Caminhos fora de `.test-lab`, links simbólicos e hardlinks são recusados. Nenhum comando usa o caminho padrão do banco real do PC.

Para ver o laboratório pela interface web de desenvolvimento do PC, após importar, abra dois terminais na raiz do projeto. No primeiro:

```powershell
$env:APP_DATA_DIR = 'C:\Projetos\Sistema de emprestimos\.test-lab\app'
$env:NOTIFICACOES_SCHEDULER = 'off'
npm.cmd run backend
```

No segundo, execute `npm.cmd run frontend` e abra o endereço mostrado pelo Vite. Confira `/health`: `dbPath` deve terminar em `.test-lab\app\emprestimos-data\database.db` antes de usar a interface. Pare o backend antes da limpeza.

O dataset contém 20 clientes fictícios, 100 contratos com taxa 10%, parcelas vigentes e originais, pagamentos, movimentos de caixa, históricos de versões e uma sequência semântica de eventos por contrato. Os identificadores `TEST-C001` e `TEST-C001-L01` são estáveis; IDs numéricos são remapeados ao importar. Valores e estados foram produzidos pelas rotinas de criação, pagamento, juros, juros parciais, juros adicionais, renegociação e capital adicional do backend do PC. Datas e seed são fixas. `dataReferencia` (`2026-09-14`) determina a classificação de vencidos no resumo, sem relógio do sistema.

A importação é idempotente e transacional. Um manifesto auxiliar, ao lado do banco, registra IDs gerados, identidades estáveis e o conteúdo inicial. A limpeza exige que as identidades dos 20 clientes e 100 contratos ainda coincidam com o manifesto. Ela remove os registros do dataset e os pagamentos, parcelas, caixa, notificações e demais registros diretamente derivados desses contratos durante os testes. **Se a identidade de um cliente/contrato for alterada, outro empréstimo for criado no mesmo cliente ou um registro externo tiver dependência dos dados do laboratório, a limpeza recusa a operação inteira.** Isso evita apagar dados cuja propriedade não pode mais ser provada. Não edite o manifesto manualmente.

`npm.cmd run seed:test:generate` regenera a cópia de trabalho usando a seed `LAB-EMPRESTIMOS-10PCT-V1` e as rotinas de referência atuais. Para promover uma nova versão canônica, valide primeiro e compare o SHA-256 da cópia com o arquivo externo. Mudanças futuras nas regras do PC devem resultar em revisão explícita da versão do dataset, não em substituição silenciosa do V1.

`npm.cmd run seed:test:validate` importa em outro banco temporário com um controle fictício alheio ao dataset, verifica 20/100/10%, todas as relações, o caixa, a conciliação de capital, as consultas do PC, a reprodução byte a byte em outro fuso, a importação idempotente, rollback e a limpeza. Também inicia o backend real com `APP_DATA_DIR` isolado, confere 20 clientes e 100 empréstimos pela API e depois limpa esse banco. Gera `.test-lab/validation-v1.json`, `.test-lab/summary-v1.json` e `.test-lab/summary-v1.csv` (100 linhas, uma por contrato). O banco real nunca é aberto. A pasta `.test-lab` é ignorada pelo Git e excluída da aplicação empacotada. O seeder não é chamado pela inicialização, migrações, atualização, instalação ou build; em `NODE_ENV=production` ele recusa execução.
