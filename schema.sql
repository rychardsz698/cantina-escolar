-- Banco de dados IFOOD (SQLite). Uma tabela para cada função do site.
-- Valores em dinheiro ficam em CENTAVOS (inteiros) para evitar erros de arredondamento.
PRAGMA foreign_keys = ON;

-- Função: acesso administrativo (proprietário da cantina)
CREATE TABLE IF NOT EXISTS administradores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario    TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  criado_em  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessoes_admin (
  token     TEXT PRIMARY KEY,
  admin_id  INTEGER NOT NULL REFERENCES administradores(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL
);

-- Função: acesso do aluno (e-mail e senha) + saldo estudantil
CREATE TABLE IF NOT EXISTS alunos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nome           TEXT NOT NULL,
  email          TEXT COLLATE NOCASE,
  senha_hash     TEXT,
  turma          TEXT NOT NULL,
  saldo_centavos INTEGER NOT NULL DEFAULT 0 CHECK (saldo_centavos >= 0),
  criado_em      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alunos_email ON alunos(email);

CREATE TABLE IF NOT EXISTS sessoes_aluno (
  token     TEXT PRIMARY KEY,
  aluno_id  INTEGER NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL
);

-- Função: cardápio / gestão de produtos e estoque
CREATE TABLE IF NOT EXISTS produtos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nome           TEXT NOT NULL,
  categoria      TEXT NOT NULL CHECK (categoria IN ('Lanches','Salgados','Bebidas','Doces','Saudáveis')),
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos > 0),
  descricao      TEXT NOT NULL DEFAULT '',
  imagem         TEXT NOT NULL DEFAULT '',
  sem_gluten     INTEGER NOT NULL DEFAULT 0,
  sem_lactose    INTEGER NOT NULL DEFAULT 0,
  vegano         INTEGER NOT NULL DEFAULT 0,
  sem_acucar     INTEGER NOT NULL DEFAULT 0,
  estoque        INTEGER NOT NULL DEFAULT 0 CHECK (estoque >= 0),
  ativo          INTEGER NOT NULL DEFAULT 1,
  criado_em      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Função: pedidos (Kanban da cozinha, comprovante, QR Code)
CREATE TABLE IF NOT EXISTS pedidos (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo                  TEXT NOT NULL UNIQUE,
  aluno_id                INTEGER REFERENCES alunos(id) ON DELETE SET NULL,
  cliente                 TEXT NOT NULL,
  turma                   TEXT NOT NULL,
  total_centavos          INTEGER NOT NULL,
  horario_retirada        TEXT NOT NULL,
  forma_pagamento         TEXT NOT NULL CHECK (forma_pagamento IN ('Saldo Estudantil','PIX','Cartão')),
  observacoes             TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','preparing','ready','delivered')),
  saldo_restante_centavos INTEGER,
  criado_em               TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Função: itens de cada pedido (guarda nome e preço no momento da compra)
CREATE TABLE IF NOT EXISTS itens_pedido (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id      INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  produto_id     INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  nome           TEXT NOT NULL,
  quantidade     INTEGER NOT NULL CHECK (quantidade > 0),
  preco_centavos INTEGER NOT NULL
);

-- Função: recarga de saldo estudantil
CREATE TABLE IF NOT EXISTS recargas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  aluno_id       INTEGER NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  metodo         TEXT NOT NULL CHECK (metodo IN ('PIX','Cartão')),
  criado_em      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
CREATE INDEX IF NOT EXISTS idx_pedidos_aluno  ON pedidos(aluno_id);
CREATE INDEX IF NOT EXISTS idx_itens_pedido   ON itens_pedido(pedido_id);
CREATE INDEX IF NOT EXISTS idx_recargas_aluno ON recargas(aluno_id);
