-- capital_restante.sql

-- 1. Adiciona a coluna capital_restante (se ainda não existir)
ALTER TABLE emprestimos ADD COLUMN capital_restante REAL;

-- 2. Atualiza os valores com base nas parcelas não pagas
UPDATE emprestimos
SET capital_restante = (
  SELECT SUM(valor_capital)
  FROM parcelas
  WHERE parcelas.emprestimo_id = emprestimos.id AND pago = 0
);