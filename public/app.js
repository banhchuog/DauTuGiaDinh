/* ══════════════════════════════════════════════════════
   PORTFOLIO TRACKER — app.js
   Toàn bộ logic: fetch giá, render UI, CRUD đầu tư
══════════════════════════════════════════════════════ */

// ──────────────────────────────
// STATE
// ──────────────────────────────
let portfolio = { investments: [] };
let priceCache = {};        // { id: priceData }
let allocationChart = null;
let currentFilter = 'all';
let deleteId = null;
let isRefreshing = false;

// Màu cho chart
const PALETTE = [
  '#3B82F6','#6366F1','#F59E0B','#10B981',
  '#EF4444','#8B5CF6','#EC4899','#14B8A6',
  '#F97316','#06B6D4','#84CC16','#A855F7'
];

// ──────────────────────────────
// INIT
// ──────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setPageDate();
  await loadPortfolio();
  renderAll();
  await refreshPrices();
  setupEventListeners();
});

function setPageDate() {
  const d = new Date();
  const opts = { weekday:'long', year:'numeric', month:'long', day:'numeric' };
  document.getElementById('pageDate').textContent = d.toLocaleDateString('vi-VN', opts);
}

// ──────────────────────────────
// LOAD / SAVE
// ──────────────────────────────
async function loadPortfolio() {
  try {
    const res = await fetch('/api/portfolio');
    portfolio = await res.json();
    if (!portfolio.investments) portfolio.investments = [];
  } catch {
    portfolio = { investments: [] };
  }
}

async function savePortfolio() {
  await fetch('/api/portfolio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(portfolio)
  });
}

// ──────────────────────────────
// REFRESH PRICES (batch)
// ──────────────────────────────
async function refreshPrices() {
  if (isRefreshing || !portfolio.investments.length) return;
  isRefreshing = true;

  const refreshBtn = document.getElementById('refreshBtn');
  const refreshIcon = document.getElementById('refreshIcon');
  refreshBtn.classList.add('loading');
  refreshIcon.classList.add('fa-spin');
  showToast('Đang cập nhật giá thị trường...', 'info');

  try {
    const items = portfolio.investments.map(inv => ({
      id: inv.id, type: inv.type, symbol: inv.symbol
    }));

    const res = await fetch('/api/prices/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });

    const priceMap = await res.json();
    let updated = 0;

    for (const [id, priceData] of Object.entries(priceMap)) {
      if (priceData && priceData.price > 0) {
        priceCache[id] = priceData;
        updated++;
      }
    }

    document.getElementById('lastUpdated').textContent =
      new Date().toLocaleTimeString('vi-VN');

    renderAll();

    if (updated > 0) {
      showToast(`✅ Đã cập nhật giá ${updated} khoản đầu tư`, 'success');
    } else {
      showToast('⚠️ Không thể lấy giá. Thử lại sau', 'error');
    }
  } catch (e) {
    console.error('[refreshPrices]', e);
    showToast('❌ Lỗi kết nối. Kiểm tra mạng', 'error');
  } finally {
    isRefreshing = false;
    refreshBtn.classList.remove('loading');
    refreshIcon.classList.remove('fa-spin');
  }
}

// ──────────────────────────────
// RENDER ALL
// ──────────────────────────────
function renderAll() {
  renderSummary();
  renderChart();
  renderInvestments();
}

// ──────────────────────────────
// CALCULATIONS
// ──────────────────────────────
function calcItem(inv) {
  const price = priceCache[inv.id];
  const currentPrice = price?.price ?? 0;
  const costValue = inv.quantity * inv.purchasePrice;
  const currentValue = currentPrice > 0 ? inv.quantity * currentPrice : 0;
  const pnl = currentValue > 0 ? currentValue - costValue : 0;
  const pnlPct = costValue > 0 && currentValue > 0
    ? ((currentValue - costValue) / costValue) * 100
    : null;
  return { currentPrice, costValue, currentValue, pnl, pnlPct, hasPrice: currentPrice > 0 };
}

function calcTotal() {
  let totalCost = 0, totalValue = 0, pricedCount = 0;
  for (const inv of portfolio.investments) {
    const c = calcItem(inv);
    totalCost += c.costValue;
    if (c.hasPrice) { totalValue += c.currentValue; pricedCount++; }
  }
  const totalPnL = pricedCount > 0 ? totalValue - totalCost : 0;
  const totalPnLPct = totalCost > 0 && pricedCount > 0
    ? (totalPnL / totalCost) * 100
    : null;
  return { totalCost, totalValue, totalPnL, totalPnLPct, pricedCount };
}

// ──────────────────────────────
// RENDER SUMMARY
// ──────────────────────────────
function renderSummary() {
  const { totalCost, totalValue, totalPnL, totalPnLPct, pricedCount } = calcTotal();

  // Tổng giá trị hiện tại
  setEl('totalValue', pricedCount > 0 ? fmtVND(totalValue) : '<span class="skeleton">──────────</span>');

  // Tổng vốn
  setEl('totalCost', fmtVND(totalCost));

  // PnL
  const pnlEl = document.getElementById('totalPnL');
  const pnlIcon = document.getElementById('pnlIcon');
  const pctEl = document.getElementById('totalPnLPct');
  const pctIcon = document.getElementById('pctIcon');

  if (pricedCount > 0) {
    const isProfit = totalPnL >= 0;
    const sign = isProfit ? '+' : '';
    pnlEl.innerHTML = `${sign}${fmtVND(totalPnL)}`;
    pnlEl.style.color = isProfit ? 'var(--green)' : 'var(--red)';

    pnlIcon.className = `summary-icon ${isProfit ? 'icon-green' : 'icon-red'}`;
    pctIcon.className = `summary-icon ${isProfit ? 'icon-green' : 'icon-red'}`;

    if (totalPnLPct !== null) {
      pctEl.innerHTML = `${sign}${totalPnLPct.toFixed(2)}%`;
      pctEl.style.color = isProfit ? 'var(--green)' : 'var(--red)';
    } else {
      setEl('totalPnLPct', '--');
    }
  } else {
    pnlEl.innerHTML = '<span class="skeleton">──────────</span>';
    pctEl.innerHTML = '<span class="skeleton">──────────</span>';
  }
}

// ──────────────────────────────
// RENDER CHART
// ──────────────────────────────
function renderChart() {
  const canvas = document.getElementById('allocationChart');
  const ctx = canvas.getContext('2d');

  const invs = portfolio.investments;
  if (!invs.length) return;

  // Nhóm theo symbol để vẽ biểu đồ phân bổ (theo giá trị hiện tại)
  const items = invs.map((inv, i) => {
    const c = calcItem(inv);
    return {
      label: inv.symbol,
      value: c.hasPrice ? c.currentValue : c.costValue,
      color: PALETTE[i % PALETTE.length]
    };
  }).filter(x => x.value > 0);

  if (!items.length) return;

  const total = items.reduce((s, x) => s + x.value, 0);

  // Doughnut chart
  if (allocationChart) allocationChart.destroy();

  allocationChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: items.map(x => x.label),
      datasets: [{
        data: items.map(x => x.value),
        backgroundColor: items.map(x => x.color),
        borderColor: '#1E293B',
        borderWidth: 3,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '70%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const val = context.parsed;
              const pct = ((val / total) * 100).toFixed(1);
              return ` ${context.label}: ${fmtVND(val)} (${pct}%)`;
            }
          }
        }
      }
    }
  });

  // Center text
  document.getElementById('doughnutTotal').textContent = fmtVNDShort(total);

  // Legend
  const legend = document.getElementById('chartLegend');
  legend.innerHTML = items.map((x, i) => {
    const pct = ((x.value / total) * 100).toFixed(1);
    return `<div class="legend-item">
      <span class="legend-dot" style="background:${x.color}"></span>
      <span>${x.label} <span style="color:var(--text-3)">${pct}%</span></span>
    </div>`;
  }).join('');

  // Performance list
  renderPerfList(items, total);
}

function renderPerfList(items, total) {
  const perfEl = document.getElementById('perfList');
  const sorted = [...portfolio.investments].map((inv, i) => {
    const c = calcItem(inv);
    return { inv, c, color: PALETTE[i % PALETTE.length] };
  }).sort((a, b) => {
    const pa = a.c.pnlPct ?? -999, pb = b.c.pnlPct ?? -999;
    return pb - pa;
  });

  if (!sorted.length) { perfEl.innerHTML = '<div class="empty-perf">Chưa có dữ liệu</div>'; return; }

  const maxAbsPct = Math.max(...sorted.map(s => Math.abs(s.c.pnlPct ?? 0)), 1);

  perfEl.innerHTML = sorted.map(({ inv, c, color }) => {
    const sign = c.pnlPct >= 0 ? '+' : '';
    const cls = c.pnlPct > 0 ? 'profit' : c.pnlPct < 0 ? 'loss' : 'neutral';
    const pctStr = c.pnlPct !== null ? `${sign}${c.pnlPct.toFixed(2)}%` : '–';
    const barColor = c.pnlPct > 0 ? 'var(--green)' : c.pnlPct < 0 ? 'var(--red)' : 'var(--text-3)';
    const barW = c.pnlPct !== null ? Math.min(Math.abs(c.pnlPct) / maxAbsPct * 100, 100) : 0;
    const typeMap = { stock: 'CP', gold: 'Vàng', crypto: 'Crypto', other: 'Khác' };

    return `<div class="perf-item">
      <span class="perf-dot" style="background:${color}"></span>
      <span class="perf-name">${inv.symbol}</span>
      <span class="perf-type-badge">${typeMap[inv.type] || inv.type}</span>
      <div class="perf-bar-wrap">
        <div class="perf-bar" style="width:${barW}%;background:${barColor}"></div>
      </div>
      <span class="perf-pct" style="color:${barColor}">${pctStr}</span>
      <span class="perf-value">${c.hasPrice ? fmtVNDShort(c.pnl) : '–'}</span>
    </div>`;
  }).join('');
}

// ──────────────────────────────
// RENDER INVESTMENT CARDS
// ──────────────────────────────
function renderInvestments() {
  const loadingEl  = document.getElementById('loadingState');
  const listEl     = document.getElementById('investmentsList');
  const emptyEl    = document.getElementById('emptyState');

  loadingEl.style.display = 'none';

  const filtered = portfolio.investments.filter(inv =>
    currentFilter === 'all' || inv.type === currentFilter
  );

  if (!portfolio.investments.length) {
    listEl.style.display  = 'none';
    emptyEl.style.display = 'block';
    return;
  }

  listEl.style.display  = 'grid';
  emptyEl.style.display = 'none';

  if (!filtered.length) {
    listEl.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-3)">
      Không có khoản đầu tư loại này
    </div>`;
    return;
  }

  listEl.innerHTML = filtered.map(inv => buildInvestCard(inv)).join('');
}

function buildInvestCard(inv) {
  const c = calcItem(inv);
  const sign = c.pnl >= 0 ? '+' : '';
  const cls = c.pnl > 0 ? 'profit' : c.pnl < 0 ? 'loss' : 'neutral';
  const icon = typeIcon(inv.type, inv.symbol);
  const typeMap = { stock: 'Cổ phiếu', gold: 'Vàng', crypto: 'Crypto', other: 'Khác' };
  const badgeClass = `badge-${inv.type}`;
  const unitLabel = inv.type === 'gold' ? 'lượng' : inv.type === 'crypto' ? 'coin' : 'cp';

  const priceChangeHtml = (() => {
    const pd = priceCache[inv.id];
    if (!pd) return '';
    const ch = pd.change ?? 0;
    const chPct = pd.changePercent ?? 0;
    if (ch === 0 && chPct === 0) return '';
    const dir = ch >= 0 ? 'up' : 'down';
    const s = ch >= 0 ? '▲' : '▼';
    return `<div class="ic-price-change ${dir}">${s} ${fmtVND(Math.abs(ch))} (${Math.abs(chPct).toFixed(2)}%)</div>`;
  })();

  return `<div class="invest-card ${cls}" data-id="${inv.id}">
    <div class="ic-icon ${inv.type}">${icon}</div>

    <div class="ic-info">
      <div class="ic-header">
        <span class="ic-symbol">${inv.symbol}</span>
        <span class="ic-badge ${badgeClass}">${typeMap[inv.type] || inv.type}</span>
        ${inv.notes ? `<span style="font-size:11px;color:var(--text-3)">📝 ${inv.notes}</span>` : ''}
      </div>
      <div class="ic-name">${inv.name || ''}</div>
      <div class="ic-qty-row">
        <div class="ic-qty-item">
          <span class="ic-qty-label">Số lượng</span>
          <span class="ic-qty-value">${fmtNum(inv.quantity)} ${unitLabel}</span>
        </div>
        <div class="ic-qty-item">
          <span class="ic-qty-label">Giá mua</span>
          <span class="ic-qty-value">${fmtVND(inv.purchasePrice)}</span>
        </div>
        <div class="ic-qty-item">
          <span class="ic-qty-label">Vốn đầu tư</span>
          <span class="ic-qty-value">${fmtVNDShort(c.costValue)}</span>
        </div>
        ${inv.purchaseDate ? `<div class="ic-qty-item">
          <span class="ic-qty-label">Ngày mua</span>
          <span class="ic-qty-value">${formatDate(inv.purchaseDate)}</span>
        </div>` : ''}
      </div>
    </div>

    <!-- Giá thị trường -->
    <div class="ic-prices">
      <div class="ic-current-price ${c.hasPrice ? '' : 'loading'}">
        ${c.hasPrice ? fmtVND(c.currentPrice) : '⏳ Đang tải...'}
      </div>
      ${priceChangeHtml}
      ${priceCache[inv.id]?.source ? `<div class="ic-source">📡 ${priceCache[inv.id].source}</div>` : ''}
    </div>

    <!-- PnL -->
    <div class="ic-pnl">
      <div class="ic-pnl-value ${cls}">
        ${c.hasPrice ? `${sign}${fmtVNDShort(c.pnl)}` : '–'}
      </div>
      <div class="ic-pnl-pct ${cls}">
        ${c.pnlPct !== null ? `${sign}${c.pnlPct.toFixed(2)}%` : '–'}
      </div>
      ${c.hasPrice ? `<div class="ic-total-value">≈ ${fmtVNDShort(c.currentValue)}</div>` : ''}
    </div>

    <!-- Actions -->
    <div class="ic-actions">
      <button class="action-btn edit" onclick="openEditModal('${inv.id}')" title="Sửa">
        <i class="fas fa-pen"></i>
      </button>
      <button class="action-btn del" onclick="openDeleteModal('${inv.id}')" title="Xóa">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  </div>`;
}

// ──────────────────────────────
// MODAL: ADD / EDIT
// ──────────────────────────────
function openAddModal() {
  document.getElementById('modalTitle').textContent = 'Thêm đầu tư mới';
  document.getElementById('editId').value = '';
  resetForm();
  document.getElementById('fDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('investModal').style.display = 'flex';
}

function openEditModal(id) {
  const inv = portfolio.investments.find(x => x.id === id);
  if (!inv) return;
  document.getElementById('modalTitle').textContent = 'Chỉnh sửa đầu tư';
  document.getElementById('editId').value = id;

  setType(inv.type);
  document.getElementById('fSymbol').value = inv.symbol;
  document.getElementById('fName').value   = inv.name || '';
  document.getElementById('fQty').value    = inv.quantity;
  document.getElementById('fPrice').value  = inv.purchasePrice;
  document.getElementById('fDate').value   = inv.purchaseDate || '';
  document.getElementById('fNotes').value  = inv.notes || '';
  updatePreview();
  document.getElementById('investModal').style.display = 'flex';
}

function closeAddModal() {
  document.getElementById('investModal').style.display = 'none';
}

function resetForm() {
  document.getElementById('investForm').reset();
  setType('stock');
}

// Save / Update
async function saveInvestment() {
  const id     = document.getElementById('editId').value.trim();
  const type   = document.querySelector('.type-btn.active')?.dataset.type || 'stock';
  const symbol = document.getElementById('fSymbol').value.trim().toUpperCase();
  const name   = document.getElementById('fName').value.trim();
  const qty    = parseFloat(document.getElementById('fQty').value);
  const price  = parseFloat(document.getElementById('fPrice').value);
  const date   = document.getElementById('fDate').value;
  const notes  = document.getElementById('fNotes').value.trim();

  if (!symbol) { showToast('Vui lòng nhập mã / tên tài sản', 'error'); return; }
  if (!qty || qty <= 0) { showToast('Số lượng phải lớn hơn 0', 'error'); return; }
  if (!price || price <= 0) { showToast('Giá mua phải lớn hơn 0', 'error'); return; }

  if (id) {
    // Edit
    const inv = portfolio.investments.find(x => x.id === id);
    if (inv) {
      inv.type = type; inv.symbol = symbol; inv.name = name;
      inv.quantity = qty; inv.purchasePrice = price;
      inv.purchaseDate = date; inv.notes = notes;
      if (priceCache[id]) delete priceCache[id]; // xóa cache để fetch lại
    }
    showToast('✅ Đã cập nhật', 'success');
  } else {
    // Add
    const newId = Date.now().toString();
    portfolio.investments.push({ id: newId, type, symbol, name, quantity: qty, purchasePrice: price, purchaseDate: date, notes });
    showToast('✅ Đã thêm khoản đầu tư mới', 'success');
  }

  await savePortfolio();
  closeAddModal();
  renderAll();

  // Fetch giá cho item mới
  await refreshPrices();
}

// ──────────────────────────────
// MODAL: DELETE
// ──────────────────────────────
function openDeleteModal(id) {
  const inv = portfolio.investments.find(x => x.id === id);
  if (!inv) return;
  deleteId = id;
  document.getElementById('delItemName').textContent = `${inv.symbol} – ${inv.name || ''}`;
  document.getElementById('delModal').style.display = 'flex';
}

async function confirmDelete() {
  if (!deleteId) return;
  portfolio.investments = portfolio.investments.filter(x => x.id !== deleteId);
  delete priceCache[deleteId];
  await savePortfolio();
  document.getElementById('delModal').style.display = 'none';
  deleteId = null;
  renderAll();
  showToast('🗑️ Đã xóa khỏi danh mục', 'info');
}

// ──────────────────────────────
// TYPE SELECTOR
// ──────────────────────────────
function setType(type) {
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  updateTypeUI(type);
}

function updateTypeUI(type) {
  const lblSymbol = document.getElementById('lblSymbol');
  const lblQty    = document.getElementById('lblQty');
  const lblPrice  = document.getElementById('lblPrice');
  const symbolTag = document.getElementById('symbolTag');
  const priceHint = document.getElementById('priceHint');
  const goldP     = document.getElementById('goldPresets');
  const cryptoP   = document.getElementById('cryptoPresets');
  const fSymbol   = document.getElementById('fSymbol');

  goldP.style.display   = type === 'gold'   ? 'flex' : 'none';
  cryptoP.style.display = type === 'crypto' ? 'flex' : 'none';

  if (type === 'stock') {
    lblSymbol.textContent = 'Mã cổ phiếu';
    lblQty.textContent    = 'Số lượng (cổ phiếu)';
    lblPrice.textContent  = 'Giá mua vào (VND/cp)';
    priceHint.textContent = 'VD: 99000 = 99.000đ/cổ phiếu';
    symbolTag.textContent = 'HOSE';
    fSymbol.placeholder   = 'VD: FPT, VNM, HPG';
  } else if (type === 'gold') {
    lblSymbol.textContent = 'Loại vàng';
    lblQty.textContent    = 'Số lượng (lượng)';
    lblPrice.textContent  = 'Giá mua vào (VND/lượng)';
    priceHint.textContent = 'VD: 187800000 = 187.800.000đ/lượng';
    symbolTag.textContent = 'GOLD';
    fSymbol.placeholder   = 'SJC, DOJI, PNJ, BTMC';
    if (!document.getElementById('fSymbol').value)
      document.getElementById('fSymbol').value = 'SJC';
  } else if (type === 'crypto') {
    lblSymbol.textContent = 'Mã Crypto';
    lblQty.textContent    = 'Số lượng (coin)';
    lblPrice.textContent  = 'Giá mua vào (VND/coin)';
    priceHint.textContent = 'Nhập giá tại thời điểm mua';
    symbolTag.textContent = 'COIN';
    fSymbol.placeholder   = 'VD: BTC, ETH, BNB';
  } else {
    lblSymbol.textContent = 'Mã tài sản';
    lblQty.textContent    = 'Số lượng';
    lblPrice.textContent  = 'Giá mua vào (VND)';
    priceHint.textContent = '';
    symbolTag.textContent = '';
    fSymbol.placeholder   = 'Nhập tên/mã';
  }
}

// ──────────────────────────────
// PREVIEW FORM
// ──────────────────────────────
function updatePreview() {
  const qty   = parseFloat(document.getElementById('fQty').value) || 0;
  const price = parseFloat(document.getElementById('fPrice').value) || 0;
  document.getElementById('previewTotal').textContent = fmtVND(qty * price);
}

// ──────────────────────────────
// EVENTS
// ──────────────────────────────
function setupEventListeners() {
  // Add button
  document.getElementById('addBtn').addEventListener('click', openAddModal);

  // Refresh
  document.getElementById('refreshBtn').addEventListener('click', refreshPrices);

  // Modal
  document.getElementById('closeModal').addEventListener('click', closeAddModal);
  document.getElementById('cancelModal').addEventListener('click', closeAddModal);
  document.getElementById('saveBtn').addEventListener('click', saveInvestment);

  // Delete modal
  document.getElementById('closeDelModal').addEventListener('click', () => {
    document.getElementById('delModal').style.display = 'none';
  });
  document.getElementById('cancelDel').addEventListener('click', () => {
    document.getElementById('delModal').style.display = 'none';
  });
  document.getElementById('confirmDel').addEventListener('click', confirmDelete);

  // Close backdrop
  document.getElementById('investModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAddModal();
  });
  document.getElementById('delModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) document.getElementById('delModal').style.display = 'none';
  });

  // Type buttons
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setType(btn.dataset.type);
      document.getElementById('fSymbol').value = '';
    });
  });

  // Gold presets
  document.querySelectorAll('#goldPresets .preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#goldPresets .preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('fSymbol').value = btn.dataset.val;
    });
  });

  // Crypto presets
  document.querySelectorAll('#cryptoPresets .preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#cryptoPresets .preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('fSymbol').value = btn.dataset.val;
    });
  });

  // Preview
  document.getElementById('fQty').addEventListener('input', updatePreview);
  document.getElementById('fPrice').addEventListener('input', updatePreview);

  // Filter tabs
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      renderInvestments();
    });
  });

  // Keyboard ESC
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeAddModal();
      document.getElementById('delModal').style.display = 'none';
    }
  });

  // Auto refresh mỗi 2 phút
  setInterval(refreshPrices, 120000);
}

// ──────────────────────────────
// FORMAT HELPERS
// ──────────────────────────────
function fmtVND(n) {
  if (n === null || n === undefined || isNaN(n)) return '–';
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(n);
}

function fmtVNDShort(n) {
  if (n === null || n === undefined || isNaN(n)) return '–';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)} nghìn tỷ`;
  if (abs >= 1e9)  return `${sign}${(abs / 1e9).toFixed(2)} tỷ`;
  if (abs >= 1e6)  return `${sign}${(abs / 1e6).toFixed(1)} triệu`;
  if (abs >= 1e3)  return `${sign}${(abs / 1e3).toFixed(0)} nghìn`;
  return fmtVND(n);
}

function fmtNum(n) {
  return new Intl.NumberFormat('vi-VN').format(n);
}

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return d.toLocaleDateString('vi-VN');
}

function typeIcon(type, symbol) {
  if (type === 'gold')   return '🥇';
  if (type === 'crypto') return '₿';
  if (type === 'other')  return '📦';
  // Stock: hiển thị 3 ký tự đầu
  return (symbol || 'STK').substring(0, 4);
}

function setEl(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// ──────────────────────────────
// TOAST
// ──────────────────────────────
let toastTimer;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3500);
}

// Bind sự kiện cho nút refresh trên mobile
const mobileRefBtn = document.getElementById('mobileRefreshBtn');
if (mobileRefBtn) {
  mobileRefBtn.addEventListener('click', async () => {
    mobileRefBtn.querySelector('i').classList.add('fa-spin');
    await fetchPrices();
    renderSummary();
    renderCharts();
    renderInvestments();
    mobileRefBtn.querySelector('i').classList.remove('fa-spin');
    showToast('Đã cập nhật giá mới nhất');
  });
}
