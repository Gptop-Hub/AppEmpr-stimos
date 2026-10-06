ALTER TABLE emprestimos ADD COLUMN emprestimo_uid TEXT;
UPDATE emprestimos
   SET emprestimo_uid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
 WHERE emprestimo_uid IS NULL OR trim(emprestimo_uid) = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_emprestimos_emprestimo_uid_unique ON emprestimos(emprestimo_uid) WHERE emprestimo_uid IS NOT NULL AND trim(emprestimo_uid) <> '';
CREATE TRIGGER IF NOT EXISTS trg_emprestimos_emprestimo_uid
AFTER INSERT ON emprestimos
WHEN NEW.emprestimo_uid IS NULL OR trim(NEW.emprestimo_uid) = ''
BEGIN
  UPDATE emprestimos
     SET emprestimo_uid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
   WHERE rowid = NEW.rowid;
END;
