BEGIN TRANSACTION;

ALTER TABLE emprestimos ADD COLUMN valor_emprestado REAL;
ALTER TABLE emprestimos ADD COLUMN valor_atual       REAL;

UPDATE emprestimos
   SET valor_emprestado = COALESCE(valor_emprestado, valor),
       valor_atual      = COALESCE(valor_atual, valor);

COMMIT;