/* IFOOD - integração do site com o banco de dados (API Flask + SQLite) */
const API_BASE = '';
const IMG_PADRAO = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500&auto=format&fit=crop';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const u = app.state.currentUser;
  if (u && u.token) headers.Authorization = 'Bearer ' + u.token;
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new Error('Servidor indisponível. Inicie o back-end com: python app.py');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && u && u.token && !/\/(login|cadastro)$/.test(path)) app.logout();
  if (!res.ok) throw new Error(data.erro || 'Erro na requisição.');
  return data;
}

(function () {
  const navegarOriginal = app.navigate.bind(app);
  const brl = v => `R$ ${v.toFixed(2).replace('.', ',')}`;

  Object.assign(app, {
    // ---------- sessão e carrinho (somente no navegador) ----------
    saveCart() { localStorage.setItem('ifood_cart', JSON.stringify(this.state.cart)); },
    saveUser() { localStorage.setItem('ifood_user', JSON.stringify(this.state.currentUser)); },

    navigate(view) {
      const u = this.state.currentUser;
      if (view === 'admin' && !(u && u.role === 'admin')) {
        this.showToast('Entre com a senha de administrador para acessar a Área Cantina.', 'lock');
        view = 'landing';
      } else if (view === 'student' && !u) {
        view = 'landing';
      }
      navegarOriginal(view);
    },

    // ---------- inicialização ----------
    async init() {
      try { this.state.cart = JSON.parse(localStorage.getItem('ifood_cart')) || []; } catch (e) { this.state.cart = []; }
      try { this.state.currentUser = JSON.parse(localStorage.getItem('ifood_user')); } catch (e) { this.state.currentUser = null; }
      const u = this.state.currentUser;
      if (u && u.role === 'student' && !u.token) {
        this.state.currentUser = null;
        localStorage.removeItem('ifood_user');
      } else if (u && u.role === 'student') {
        try {
          const a = await api('/api/alunos/me');
          this.state.currentUser = { ...a, role: 'student', token: u.token };
          this.saveUser();
        } catch (e) { /* se a sessão expirou, o 401 já encerra o login */ }
      }
      await Promise.all([this.carregarProdutosDoBanco(), this.loadOrders()]);
      this.renderCart();
      this.updateUserHeader();
      this.updateBalanceDisplays();
      this.refreshOrdersUI();
      if (window.lucide) lucide.createIcons();
      const cu = this.state.currentUser;
      this.navigate(cu ? (cu.role === 'admin' ? 'admin' : 'student') : 'landing');
      setInterval(async () => {
        if (!this.state.currentUser) return;
        await this.loadOrders();
        this.refreshOrdersUI();
      }, 5000);
    },

    // ---------- leitura do banco ----------
    async carregarProdutosDoBanco() {
      try {
        const produtos = await api('/api/produtos');
        this.state.products = produtos;
        this.state.cart = this.state.cart.map(i => {
          const p = produtos.find(x => x.id === i.product.id);
          return p && p.active && p.stock > 0 ? { product: p, quantity: Math.min(i.quantity, p.stock) } : null;
        }).filter(Boolean);
        this.saveCart();
        this.renderCart();
        this.renderProducts();
        this.renderAdminProductsTable();
      } catch (e) { this.showToast(e.message, 'alert-circle'); }
    },

    async loadOrders() {
      const u = this.state.currentUser;
      if (!u) { this.state.orders = []; return; }
      try {
        this.state.orders = await api(u.role === 'admin' ? '/api/pedidos' : '/api/alunos/me/pedidos');
      } catch (e) { /* o polling falha em silêncio */ }
    },

    refreshOrdersUI() {
      this.updateAdminKPIs();
      this.renderKanban();
      this.checkActiveOrderButton();
      const cur = this.state.currentActiveOrder;
      if (cur) {
        const o = this.state.orders.find(x => x.id === cur.id);
        if (o) { cur.status = o.status; this.updateReceiptStepper(o.status); }
      }
    },

    // ---------- saldo ----------
    updateBalanceDisplays() {
      const u = this.state.currentUser;
      const txt = brl((u && u.balance) || 0);
      ['studentBalanceDisplay', 'cartBalanceBadge'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = txt;
      });
      this.checkBalanceSufficiency();
    },

    checkBalanceSufficiency() {
      const total = this.state.cart.reduce((s, i) => s + i.product.price * i.quantity, 0);
      const u = this.state.currentUser;
      const saldo = (u && u.balance) || 0;
      const alertBox = document.getElementById('insufficientBalanceAlert');
      const btn = document.getElementById('btnCheckout');
      if (this.state.selectedPaymentMethod === 'Saldo Estudantil' && Math.round(total * 100) > Math.round(saldo * 100)) {
        if (alertBox) alertBox.style.display = 'flex';
        if (btn) { btn.disabled = true; btn.querySelector('span').textContent = 'Saldo Insuficiente'; }
      } else {
        if (alertBox) alertBox.style.display = 'none';
        if (btn && this.state.cart.length > 0) { btn.disabled = false; btn.querySelector('span').textContent = 'Finalizar Pedido'; }
      }
    },

    async confirmRecharge() {
      const u = this.state.currentUser;
      if (!u || u.role !== 'student') { this.showToast('Entre como aluno para recarregar o saldo.', 'user'); return; }
      const val = parseFloat(document.getElementById('rechargeCustomValue').value);
      if (isNaN(val) || val <= 0) { this.showToast('Informe um valor de recarga válido.', 'alert-triangle'); return; }
      const metodo = (document.querySelector('input[name="rechargeMethod"]:checked') || {}).value || 'PIX';
      try {
        const a = await api('/api/alunos/me/recargas', { method: 'POST', body: { valor: val, metodo } });
        this.state.currentUser = { ...u, balance: a.balance };
        this.saveUser();
        this.updateBalanceDisplays();
        this.closeRechargeModal();
        this.playSound('success');
        this.triggerCelebration();
        this.showToast(`Recarga de ${brl(val)} realizada com sucesso!`, 'wallet');
      } catch (err) { this.showToast(err.message, 'alert-triangle'); }
    },

    // ---------- login / logout ----------
    setAuthMode() {
      this.authMode = this.authMode === 'register' ? 'login' : 'register';
      const reg = this.authMode === 'register';
      document.getElementById('registerFields').style.display = reg ? 'block' : 'none';
      document.querySelector('#btnStudentSubmit span').textContent = reg ? 'Criar Conta e Entrar' : 'Entrar na Cantina';
      document.getElementById('btnToggleAuth').textContent = reg ? 'Já tenho conta. Entrar' : 'Não tem conta? Criar conta';
      document.getElementById('inputPassword').autocomplete = reg ? 'new-password' : 'current-password';
    },

    async handleStudentLogin(e) {
      e.preventDefault();
      const form = e.target;
      const val = id => document.getElementById(id).value.trim();
      const reg = this.authMode === 'register';
      const body = { email: val('inputEmail'), senha: document.getElementById('inputPassword').value };
      if (reg) { body.nome = val('inputStudentName'); body.turma = val('inputClass'); }
      try {
        const { aluno, token } = await api(reg ? '/api/alunos/cadastro' : '/api/alunos/login', { method: 'POST', body });
        this.state.currentUser = { ...aluno, role: 'student', token };
        this.saveUser();
        await this.loadOrders();
        this.updateUserHeader();
        this.updateBalanceDisplays();
        this.refreshOrdersUI();
        this.navigate('student');
        this.playSound('success');
        this.showToast(`Bem-vindo à cantina IFOOD, ${aluno.name}!`, 'check');
        form.reset();
        if (reg) this.setAuthMode();
      } catch (err) { this.showToast(err.message, 'alert-triangle'); }
    },

    async handleAdminLogin(e) {
      e.preventDefault();
      const form = e.target;
      try {
        const { token } = await api('/api/admin/login', { method: 'POST', body: { senha: document.getElementById('inputAdminPassword').value } });
        this.state.currentUser = { name: 'Proprietário da Cantina', className: 'Gestão da Cantina', role: 'admin', token };
        this.saveUser();
        await this.loadOrders();
        this.updateUserHeader();
        this.updateBalanceDisplays();
        this.refreshOrdersUI();
        this.navigate('admin');
        this.playSound('success');
        this.showToast('Acesso administrativo autenticado!', 'shield');
        form.reset();
      } catch (err) { this.showToast(err.message, 'alert-triangle'); }
    },

    logout() {
      const sessao = this.state.currentUser;
      if (sessao && sessao.token) api('/api/sair', { method: 'POST' }).catch(() => {});
      this.state.currentUser = null;
      this.state.orders = [];
      this.state.currentActiveOrder = null;
      localStorage.removeItem('ifood_user');
      this.updateUserHeader();
      this.refreshOrdersUI();
      this.navigate('landing');
      this.showToast('Sessão encerrada.', 'info');
    },

    // ---------- pedidos ----------
    async checkoutOrder() {
      if (this.state.cart.length === 0) return;
      const u = this.state.currentUser;
      if (!u || u.role !== 'student') {
        this.toggleCart(false);
        this.navigate('landing');
        this.showToast('Entre com seu e-mail e senha para finalizar o pedido.', 'user');
        return;
      }
      const notesEl = document.getElementById('cartNotes');
      try {
        const res = await api('/api/pedidos', {
          method: 'POST',
          body: {
            itens: this.state.cart.map(c => ({ produtoId: c.product.id, quantidade: c.quantity })),
            horario: this.state.selectedPickupTime,
            pagamento: this.state.selectedPaymentMethod,
            observacoes: notesEl ? notesEl.value.trim() : ''
          }
        });
        this.state.currentUser = { ...u, balance: res.aluno.balance };
        this.saveUser();
        this.state.cart = [];
        this.saveCart();
        if (notesEl) notesEl.value = '';
        await Promise.all([this.carregarProdutosDoBanco(), this.loadOrders()]);
        this.renderCart();
        this.updateBalanceDisplays();
        this.toggleCart(false);
        this.playSound('success');
        this.triggerCelebration();
        this.openReceiptModal(res.pedido);
        this.refreshOrdersUI();
      } catch (err) {
        this.showToast(err.message, 'alert-triangle');
        await this.carregarProdutosDoBanco();
      }
    },

    async moveOrderStatus(orderId, newStatus) {
      try {
        await api(`/api/pedidos/${orderId}/status`, { method: 'PATCH', body: { status: newStatus } });
      } catch (err) { this.showToast(err.message, 'alert-triangle'); return; }
      await this.loadOrders();
      this.refreshOrdersUI();
      const msg = {
        preparing: ['add', `Pedido ${orderId} em preparo.`, 'flame'],
        ready: ['bell', `Pedido ${orderId} está PRONTO no balcão!`, 'bell'],
        delivered: ['success', `Pedido ${orderId} entregue ao aluno!`, 'check-circle']
      }[newStatus];
      if (msg) { this.playSound(msg[0]); this.showToast(msg[1], msg[2]); }
    },

    // ---------- cardápio (CRUD do administrador) ----------
    async handleCreateProduct(e) {
      e.preventDefault();
      const el = id => document.getElementById(id);
      const body = {
        name: el('newProdName').value.trim(),
        category: el('newProdCategory').value,
        price: parseFloat(el('newProdPrice').value),
        description: el('newProdDesc').value.trim(),
        stock: parseInt(el('newProdStock').value, 10),
        image: el('newProdImage').value.trim() || IMG_PADRAO,
        glutenFree: el('checkGlutenFree').checked,
        lactoseFree: el('checkLactoseFree').checked,
        vegan: el('checkVegan').checked,
        sugarFree: el('checkSugarFree').checked
      };
      try {
        await api('/api/produtos', { method: 'POST', body });
        this.showToast(`"${body.name}" cadastrado com sucesso!`, 'check');
        e.target.reset();
        await this.carregarProdutosDoBanco();
      } catch (err) { this.showToast(err.message, 'alert-circle'); }
    },

    async adjustStock(id, delta) {
      const p = this.state.products.find(x => x.id === id);
      if (!p) return;
      try {
        await api(`/api/produtos/${id}`, { method: 'PATCH', body: { stock: Math.max(0, p.stock + delta) } });
        await this.carregarProdutosDoBanco();
      } catch (err) { this.showToast(err.message, 'alert-circle'); }
    },

    async toggleProductStatus(id) {
      const p = this.state.products.find(x => x.id === id);
      if (!p) return;
      try {
        await api(`/api/produtos/${id}`, { method: 'PATCH', body: { active: !p.active } });
        await this.carregarProdutosDoBanco();
      } catch (err) { this.showToast(err.message, 'alert-circle'); }
    },

    async deleteProduct(id) {
      const p = this.state.products.find(x => x.id === id);
      if (!p || !confirm(`Excluir "${p.name}" do cardápio?`)) return;
      try {
        await api(`/api/produtos/${id}`, { method: 'DELETE' });
        this.showToast('Produto excluído.', 'trash-2');
        await this.carregarProdutosDoBanco();
      } catch (err) { this.showToast(err.message, 'alert-circle'); }
    }
  });
})();
