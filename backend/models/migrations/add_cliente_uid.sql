ALTER TABLE clientes ADD COLUMN cliente_uid TEXT;
UPDATE clientes
   SET cliente_uid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
 WHERE cliente_uid IS NULL OR trim(cliente_uid) = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_cliente_uid_unique ON clientes(cliente_uid) WHERE cliente_uid IS NOT NULL AND trim(cliente_uid) <> '';
CREATE TRIGGER IF NOT EXISTS trg_clientes_cliente_uid
AFTER INSERT ON clientes
WHEN NEW.cliente_uid IS NULL OR trim(NEW.cliente_uid) = ''
BEGIN
  UPDATE clientes
     SET cliente_uid = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
   WHERE rowid = NEW.rowid;
END;
