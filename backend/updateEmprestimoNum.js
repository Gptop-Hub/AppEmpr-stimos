const db = require('./models/database');

function atualizarEmprestimosNum() {
  db.all(
    `SELECT id, cliente_id FROM emprestimos ORDER BY cliente_id, id`,
    (err, emprestimos) => {
      if (err) {
        console.error('Erro ao buscar empréstimos:', err);
        return process.exit(1);
      }

      let ultimoCliente = null;
      let contador = 0;

      const atualizaProximo = (index) => {
        if (index >= emprestimos.length) {
          console.log('Todos os empréstimos foram atualizados!');
          return process.exit(0);
        }

        const e = emprestimos[index];

        if (e.cliente_id !== ultimoCliente) {
          ultimoCliente = e.cliente_id;
          contador = 1;
        } else {
          contador++;
        }

        const novoNum = `${e.cliente_id}-${contador}`;

        db.run(
          `UPDATE emprestimos SET emprestimo_num = ? WHERE id = ?`,
          [novoNum, e.id],
          (err) => {
            if (err) {
              console.error(`Erro ao atualizar empréstimo id ${e.id}:`, err);
            } else {
              console.log(`Empréstimo id ${e.id} atualizado para '${novoNum}'`);
            }
            atualizaProximo(index + 1);
          }
        );
      };

      atualizaProximo(0);
    }
  );
}

atualizarEmprestimosNum();