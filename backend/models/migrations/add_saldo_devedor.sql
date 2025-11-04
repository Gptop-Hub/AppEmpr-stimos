ALTER TABLE emprestimos ADD COLUMN saldo_devedor REAL;
UPDATE emprestimos SET saldo_devedor = valor;