// IFOOD - servidor (Node.js + Express + SQLite). Rode com: npm install && npm start
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CATS = ['Lanches', 'Salgados', 'Bebidas', 'Doces', 'Saudáveis'];
const HORARIOS = ['Recreio da Manhã (09:45 - 10:05)', 'Almoço (12:00 - 13:00)', 'Recreio da Tarde (15:45 - 16:05)'];
const PAGAMENTOS = ['Saldo Estudantil', 'PIX', 'Cartão'];
const STATUS = ['received', 'preparing', 'ready', 'delivered'];
const MAPA = { name: 'nome', category: 'categoria', description: 'descricao', image: 'imagem', glutenFree: 'sem_gluten',
  lactoseFree: 'sem_lactose', vegan: 'vegano', sugarFree: 'sem_acucar', stock: 'estoque', active: 'ativo' };
const BOOLS = ['glutenFree', 'lactoseFree', 'vegan', 'sugarFree', 'active'];

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'ifood.db'));
db.pragma('foreign_keys = ON');
// bancos criados antes do login por e-mail: acrescenta as colunas novas
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alunos'").get() &&
    !db.pragma('table_info(alunos)').some(c => c.name === 'email'))
  db.exec('ALTER TABLE alunos ADD COLUMN email TEXT COLLATE NOCASE; ALTER TABLE alunos ADD COLUMN senha_hash TEXT;');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

class Erro extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const p2 = n => String(n).padStart(2, '0');
const agora = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const cent = v => { const n = Math.round(parseFloat(v) * 100); if (!Number.isFinite(n)) throw new Erro('Valor inválido.'); return n; };
const reais = c => (c == null ? null : c / 100);
const hash = s => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(s, salt, 64).toString('hex'); };
const confere = (s, h) => {
  const [salt, k] = h.split(':'); const a = Buffer.from(k, 'hex'); const b = crypto.scryptSync(s, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const prod = r => ({ id: r.id, name: r.nome, category: r.categoria, price: reais(r.preco_centavos), description: r.descricao,
  image: r.imagem, glutenFree: !!r.sem_gluten, lactoseFree: !!r.sem_lactose, vegan: !!r.vegano, sugarFree: !!r.sem_acucar,
  stock: r.estoque, active: !!r.ativo });
const aluno = r => ({ id: r.id, name: r.nome, email: r.email, className: r.turma, balance: reais(r.saldo_centavos) });
const pedido = r => ({
  id: r.codigo, client: r.cliente, className: r.turma,
  items: db.prepare('SELECT nome, quantidade, preco_centavos FROM itens_pedido WHERE pedido_id=? ORDER BY id').all(r.id)
    .map(i => ({ name: i.nome, qty: i.quantidade, price: reais(i.preco_centavos) })),
  total: reais(r.total_centavos), pickupShift: r.horario_retirada, paymentMethod: r.forma_pagamento, notes: r.observacoes,
  status: r.status, remainingBalance: reais(r.saldo_restante_centavos), time: r.criado_em.slice(11, 16)
});

const admin = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t || !db.prepare('SELECT 1 FROM sessoes_admin WHERE token=? AND expira_em>?').get(t, agora()))
    throw new Erro('Acesso restrito ao administrador.', 401);
  next();
};

const bearer = req => (req.headers.authorization || '').replace('Bearer ', '');
const alunoAuth = (req, res, next) => {
  const a = db.prepare('SELECT a.* FROM sessoes_aluno s JOIN alunos a ON a.id = s.aluno_id WHERE s.token=? AND s.expira_em>?')
    .get(bearer(req), agora());
  if (!a) throw new Erro('Sessão expirada. Entre novamente.', 401);
  req.aluno = a;
  next();
};
const abrirSessao = id => {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessoes_aluno WHERE expira_em<=?').run(agora());
  db.prepare('INSERT INTO sessoes_aluno (token, aluno_id, expira_em) VALUES (?,?,?)')
    .run(token, id, agora(new Date(Date.now() + 30 * 24 * 3600 * 1000)));
  return token;
};
// limite de tentativas de login (8 erros a cada 10 minutos)
const falhas = new Map();
const limitar = k => { const f = falhas.get(k); if (f && f.n >= 8 && f.ate > Date.now()) throw new Erro('Muitas tentativas. Aguarde alguns minutos.', 429); };
const falhou = k => { const f = falhas.get(k); falhas.set(k, f && f.ate > Date.now() ? { n: f.n + 1, ate: f.ate } : { n: 1, ate: Date.now() + 600000 }); };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const limpar = s => String(s || '').split(/\s+/).filter(Boolean).join(' ');

const app = express();
if (process.env.RENDER) app.set('trust proxy', 1); // atrás do proxy da hospedagem, req.ip passa a ser o do visitante
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.send('ok'));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));

// ---------- administrador ----------
app.post('/api/admin/login', (req, res) => {
  const a = db.prepare('SELECT * FROM administradores ORDER BY id LIMIT 1').get();
  const k = 'admin:' + req.ip;
  limitar(k);
  if (!a || !confere(String((req.body || {}).senha || ''), a.senha_hash)) { falhou(k); throw new Erro('Senha incorreta.', 401); }
  falhas.delete(k);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessoes_admin WHERE expira_em<=?').run(agora());
  db.prepare('INSERT INTO sessoes_admin (token, admin_id, expira_em) VALUES (?,?,?)')
    .run(token, a.id, agora(new Date(Date.now() + 12 * 3600 * 1000)));
  res.json({ token });
});

// ---------- produtos ----------
function validarProduto(d, completo) {
  const out = {};
  for (const [k, col] of Object.entries(MAPA)) {
    if (!(k in d)) continue;
    let v = d[k];
    if (BOOLS.includes(k)) v = v ? 1 : 0;
    else if (k === 'stock') {
      v = parseInt(v, 10);
      if (Number.isNaN(v)) throw new Erro('Estoque inválido.');
      if (v < 0) throw new Erro('Estoque não pode ser negativo.');
    } else v = String(v).trim();
    out[col] = v;
  }
  if ('price' in d) {
    out.preco_centavos = cent(d.price);
    if (out.preco_centavos <= 0) throw new Erro('O preço deve ser maior que zero.');
  }
  if ('nome' in out && !out.nome) throw new Erro('Informe o nome do produto.');
  if ('categoria' in out && !CATS.includes(out.categoria)) throw new Erro('Categoria inválida.');
  if (completo) {
    if (!out.nome || !out.categoria || out.preco_centavos == null) throw new Erro('Informe nome, categoria e preço.');
    if (out.estoque == null) out.estoque = 0;
  }
  return out;
}

app.get('/api/produtos', (req, res) => res.json(db.prepare('SELECT * FROM produtos ORDER BY id').all().map(prod)));

app.post('/api/produtos', admin, (req, res) => {
  const v = validarProduto(req.body || {}, true), cols = Object.keys(v);
  const r = db.prepare(`INSERT INTO produtos (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`).run(v);
  res.status(201).json(prod(db.prepare('SELECT * FROM produtos WHERE id=?').get(r.lastInsertRowid)));
});

app.patch('/api/produtos/:id', admin, (req, res) => {
  const v = validarProduto(req.body || {}, false), cols = Object.keys(v), id = parseInt(req.params.id, 10);
  if (!cols.length) throw new Erro('Nada para atualizar.');
  const r = db.prepare(`UPDATE produtos SET ${cols.map(c => c + '=@' + c).join(',')} WHERE id=@id`).run({ ...v, id });
  if (!r.changes) throw new Erro('Produto não encontrado.', 404);
  res.json(prod(db.prepare('SELECT * FROM produtos WHERE id=?').get(id)));
});

app.delete('/api/produtos/:id', admin, (req, res) => {
  if (!db.prepare('DELETE FROM produtos WHERE id=?').run(parseInt(req.params.id, 10)).changes) throw new Erro('Produto não encontrado.', 404);
  res.json({ ok: true });
});

// ---------- alunos (e-mail e senha) e recargas ----------
app.post('/api/alunos/cadastro', (req, res) => {
  const d = req.body || {}, nome = limpar(d.nome), turma = limpar(d.turma);
  const email = String(d.email || '').trim().toLowerCase(), senha = String(d.senha || '');
  if (!nome || !turma) throw new Erro('Informe seu nome e turma.');
  if (nome.length > 60 || turma.length > 40) throw new Erro('Nome ou turma muito longo.');
  if (!EMAIL.test(email) || email.length > 120) throw new Erro('Informe um e-mail válido.');
  if (senha.length < 6) throw new Erro('A senha deve ter ao menos 6 caracteres.');
  if (db.prepare('SELECT 1 FROM alunos WHERE email=?').get(email)) throw new Erro('Este e-mail já está cadastrado. Faça login.', 409);
  const id = db.prepare('INSERT INTO alunos (nome, email, senha_hash, turma) VALUES (?,?,?,?)')
    .run(nome, email, hash(senha), turma).lastInsertRowid;
  res.status(201).json({ aluno: aluno(db.prepare('SELECT * FROM alunos WHERE id=?').get(id)), token: abrirSessao(id) });
});

app.post('/api/alunos/login', (req, res) => {
  const d = req.body || {}, email = String(d.email || '').trim().toLowerCase(), k = 'aluno:' + email;
  limitar(k);
  const a = db.prepare('SELECT * FROM alunos WHERE email=?').get(email);
  if (!a || !a.senha_hash || !confere(String(d.senha || ''), a.senha_hash)) { falhou(k); throw new Erro('E-mail ou senha incorretos.', 401); }
  falhas.delete(k);
  res.json({ aluno: aluno(a), token: abrirSessao(a.id) });
});

app.post('/api/sair', (req, res) => {
  const t = bearer(req);
  db.prepare('DELETE FROM sessoes_aluno WHERE token=?').run(t);
  db.prepare('DELETE FROM sessoes_admin WHERE token=?').run(t);
  res.json({ ok: true });
});

app.get('/api/alunos/me', alunoAuth, (req, res) => res.json(aluno(req.aluno)));

app.post('/api/alunos/me/recargas', alunoAuth, (req, res) => {
  const aid = req.aluno.id, v = cent((req.body || {}).valor);
  if (v < 100 || v > 100000) throw new Erro('Informe um valor entre R$ 1,00 e R$ 1.000,00.');
  const metodo = String((req.body || {}).metodo || '').toLowerCase().startsWith('cart') ? 'Cartão' : 'PIX';
  const r = db.transaction(() => {
    db.prepare('INSERT INTO recargas (aluno_id, valor_centavos, metodo) VALUES (?,?,?)').run(aid, v, metodo);
    db.prepare('UPDATE alunos SET saldo_centavos = saldo_centavos + ? WHERE id=?').run(v, aid);
    return db.prepare('SELECT * FROM alunos WHERE id=?').get(aid);
  }).immediate();
  res.json(aluno(r));
});

app.get('/api/alunos/me/pedidos', alunoAuth, (req, res) =>
  res.json(db.prepare('SELECT * FROM pedidos WHERE aluno_id=? ORDER BY id DESC').all(req.aluno.id).map(pedido)));

// ---------- pedidos ----------
app.post('/api/pedidos', alunoAuth, (req, res) => {
  const d = req.body || {}, itens = Array.isArray(d.itens) ? d.itens : [];
  const obs = String(d.observacoes || '').trim().slice(0, 200);
  if (!itens.length) throw new Erro('O pedido está vazio.');
  if (!PAGAMENTOS.includes(d.pagamento)) throw new Erro('Forma de pagamento inválida.');
  if (!HORARIOS.includes(d.horario)) throw new Erro('Horário de retirada inválido.');
  const out = db.transaction(() => {
    const al = db.prepare('SELECT * FROM alunos WHERE id=?').get(req.aluno.id);
    if (!al) throw new Erro('Aluno não encontrado. Entre novamente.', 404);
    const linhas = []; let total = 0;
    for (const it0 of itens) {
      const it = it0 || {}, q = parseInt(it.quantidade, 10), pid = parseInt(it.produtoId, 10);
      if (!(q > 0) || !(pid > 0)) throw new Erro('Item inválido.');
      const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(pid);
      if (!p || !p.ativo) throw new Erro('Um dos itens não está mais disponível.');
      if (p.estoque < q) throw new Erro(`Estoque insuficiente para "${p.nome}".`);
      db.prepare('UPDATE produtos SET estoque = estoque - ? WHERE id=?').run(q, pid);
      linhas.push([p, q]); total += p.preco_centavos * q;
    }
    let restante = null;
    if (d.pagamento === 'Saldo Estudantil') {
      if (total > al.saldo_centavos) throw new Erro('Saldo insuficiente. Recarregue seus créditos.');
      restante = al.saldo_centavos - total;
      db.prepare('UPDATE alunos SET saldo_centavos=? WHERE id=?').run(restante, al.id);
    }
    const oid = db.prepare(`INSERT INTO pedidos (codigo, aluno_id, cliente, turma, total_centavos, horario_retirada,
      forma_pagamento, observacoes, saldo_restante_centavos) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(crypto.randomBytes(8).toString('hex'), al.id, al.nome, al.turma, total, d.horario, d.pagamento, obs, restante).lastInsertRowid;
    db.prepare('UPDATE pedidos SET codigo=? WHERE id=?').run(`IF-${1000 + Number(oid)}`, oid);
    for (const [p, q] of linhas)
      db.prepare('INSERT INTO itens_pedido (pedido_id, produto_id, nome, quantidade, preco_centavos) VALUES (?,?,?,?,?)')
        .run(oid, p.id, p.nome, q, p.preco_centavos);
    return { pedido: pedido(db.prepare('SELECT * FROM pedidos WHERE id=?').get(oid)),
             aluno: aluno(db.prepare('SELECT * FROM alunos WHERE id=?').get(al.id)) };
  }).immediate();
  res.status(201).json(out);
});

app.get('/api/pedidos', admin, (req, res) => res.json(db.prepare('SELECT * FROM pedidos ORDER BY id DESC').all().map(pedido)));

app.patch('/api/pedidos/:codigo/status', admin, (req, res) => {
  const st = (req.body || {}).status;
  if (!STATUS.includes(st)) throw new Erro('Status inválido.');
  if (!db.prepare('UPDATE pedidos SET status=? WHERE codigo=?').run(st, req.params.codigo).changes) throw new Erro('Pedido não encontrado.', 404);
  res.json({ ok: true });
});

app.use((e, req, res, next) => {
  if (e instanceof Erro) return res.status(e.status).json({ erro: e.message });
  if (e.type === 'entity.parse.failed') return res.status(400).json({ erro: 'Requisição inválida.' });
  console.error(e);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

// ---------- inicialização ----------
if (process.argv.includes('--redefinir-admin')) {
  const s = process.env.ADMIN_SENHA || '';
  if (s.length < 6) { console.error('Defina ADMIN_SENHA (mín. 6 caracteres). Ex.: ADMIN_SENHA=minhasenha node server.js --redefinir-admin'); process.exit(1); }
  db.prepare('UPDATE administradores SET senha_hash=?').run(hash(s));
  db.prepare('DELETE FROM sessoes_admin').run();
  console.log('Senha do administrador atualizada.');
  process.exit(0);
}
if (!db.prepare('SELECT 1 FROM administradores').get()) {
  const gerada = !process.env.ADMIN_SENHA;
  const senha = process.env.ADMIN_SENHA || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO administradores (usuario, senha_hash) VALUES (?,?)').run('admin', hash(senha));
  if (gerada) console.log(`\n${'='.repeat(56)}\n  Senha do administrador (anote, só aparece agora): ${senha}\n${'='.repeat(56)}\n`);
}
// Produtos de exemplo, só se SEED_DEMO=1 e o cardápio estiver vazio (útil na hospedagem grátis, que apaga o banco ao reiniciar)
if (process.env.SEED_DEMO === '1' && !db.prepare('SELECT 1 FROM produtos').get()) {
  const img = id => `https://images.unsplash.com/photo-${id}?w=500&auto=format&fit=crop`;
  const ins = db.prepare('INSERT INTO produtos (nome, categoria, preco_centavos, descricao, imagem, sem_gluten, sem_lactose, vegano, sem_acucar, estoque) VALUES (?,?,?,?,?,?,?,?,?,?)');
  db.transaction(() => [
    ['Coxinha Dourada de Frango', 'Salgados', 750, 'Massa crocante recheada com frango desfiado e requeijão cremoso.', img('1541592106381-b31e9677c0e5'), 0, 0, 0, 1, 35],
    ['Sanduíche Natural de Frango & Cenoura', 'Lanches', 900, 'Pão integral com pasta de frango, alface e cenoura ralada.', img('1528735602780-2552fd46c7af'), 0, 1, 0, 1, 20],
    ['Suco de Laranja Integral 400ml', 'Bebidas', 650, 'Espremido na hora, sem adição de açúcar.', img('1613478223719-2ab802602423'), 1, 1, 1, 1, 45],
    ['Salada de Frutas Tropicais com Chia', 'Saudáveis', 800, 'Manga, melão, morango, uva e abacaxi com sementes de chia.', img('1540420773420-3366772f4999'), 1, 1, 1, 1, 18],
    ['Bolo Caseiro de Cenoura com Chocolate', 'Doces', 600, 'Fatia fofinha com calda de chocolate meio amargo.', img('1578985545062-69928b1d9587'), 0, 0, 0, 0, 22],
    ['Água Mineral 500ml', 'Bebidas', 350, 'Sem gás.', img('1548839140-29a749e1bc4e'), 1, 1, 1, 1, 50]
  ].forEach(p => ins.run(...p)))();
}
const PORTA = process.env.PORT || 5000;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
app.listen(PORTA, HOST, () => console.log(`IFOOD rodando na porta ${PORTA} (http://localhost:${PORTA})`));
