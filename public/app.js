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
let currentPage = 'main';  // 'main' | 'forecast' | 'gold-health'
let ghCharts = {};   // Chart.js instances for gold health page

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
  injectManualGoldPrices();
  renderAll();
  await refreshPrices();
  setupEventListeners();
  initForecastPage();
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
// GIÁ VÀNG THỦ CÔNG
// ──────────────────────────────
function injectManualGoldPrices() {
  if (!portfolio.goldPrice || portfolio.goldPrice <= 0) return;
  for (const inv of portfolio.investments) {
    if (inv.type === 'gold') {
      priceCache[inv.id] = {
        price: portfolio.goldPrice,
        change: 0,
        changePercent: 0,
        source: 'Nhập thủ công',
        lastUpdated: new Date().toISOString()
      };
    }
  }
}

function updateGoldPriceRow() {
  const hasGold = portfolio.investments.some(inv => inv.type === 'gold');
  const row = document.getElementById('goldPriceRow');
  if (!row) return;
  row.style.display = hasGold ? 'flex' : 'none';
  if (hasGold && portfolio.goldPrice) {
    const input = document.getElementById('goldPriceInput');
    if (input) input.value = portfolio.goldPrice;
  }
  // Hiển badge tự động nếu có khoản vàng đã lấy giá tự động
  const hasAutoGold = portfolio.investments.some(inv =>
    inv.type === 'gold' && priceCache[inv.id]?.source && priceCache[inv.id].source !== 'Nhập thủ công'
  );
  const badge = document.getElementById('goldPriceSource');
  if (badge) badge.style.display = hasAutoGold ? 'inline-flex' : 'none';
}

async function saveGoldPrice() {
  const input = document.getElementById('goldPriceInput');
  const price = parseFloat(String(input.value).replace(/[^\d.]/g, ''));
  if (!price || price < 1_000_000) {
    showToast('Giá vàng không hợp lệ', 'error');
    return;
  }
  portfolio.goldPrice = price;
  await savePortfolio();
  injectManualGoldPrices();
  renderAll();
  showToast(`✅ Giá vàng: ${fmtVNDShort(price)}/lượng`, 'success');
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
  refreshIcon.classList.add('svg-spin');
  showToast('Đang cập nhật giá thị trường...', 'info');

  try {
    // Gửi tất cả khoản đầu tư lên API (kể cả vàng – server tự tính)
    const items = portfolio.investments
      .map(inv => ({ id: inv.id, type: inv.type, symbol: inv.symbol }));

    let priceMap = {};
    if (items.length > 0) {
      const res = await fetch('/api/prices/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
      });
      priceMap = await res.json();
    }

    let updated = 0;
    let goldAutoFetched = false;
    for (const [id, priceData] of Object.entries(priceMap)) {
      if (priceData && priceData.price > 0) {
        priceCache[id] = priceData;
        updated++;
        // Nếu vàng tự động lấy được, cập nhật goldPrice để hiển thị đúng
        const inv = portfolio.investments.find(i => i.id === id);
        if (inv?.type === 'gold') {
          portfolio.goldPrice = priceData.price;
          goldAutoFetched = true;
          // Cập nhật input hiển thị
          const inp = document.getElementById('goldPriceInput');
          if (inp) inp.value = priceData.price;
        }
      }
    }

    // Fallback: vàng thủ công nếu API không lấy được
    if (!goldAutoFetched) {
      injectManualGoldPrices();
      updated += portfolio.investments.filter(inv => inv.type === 'gold' && portfolio.goldPrice > 0).length;
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
    refreshIcon.classList.remove('svg-spin');
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
    if (inv.hidden) {
      // Ẩn: tính vốn vào giá trị hiện tại để tổng vốn không thay đổi, PnL = 0
      totalValue += c.costValue;
      pricedCount++;
    } else if (c.hasPrice) {
      totalValue += c.currentValue;
      pricedCount++;
    }
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
  const sorted = [...portfolio.investments]
  .filter(inv => !inv.hidden)
  .map((inv, i) => {
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
  updateGoldPriceRow();
}

function buildInvestCard(inv) {
  const c = calcItem(inv);
  const sign = c.pnl >= 0 ? '+' : '';
  const cls = inv.hidden ? 'neutral' : (c.pnl > 0 ? 'profit' : c.pnl < 0 ? 'loss' : 'neutral');
  const icon = typeIcon(inv.type, inv.symbol);
  const typeMap = { stock: 'Cổ phiếu', gold: 'Vàng', crypto: 'Crypto', other: 'Khác' };
  const badgeClass = `badge-${inv.type}`;
  const unitLabel = inv.type === 'gold' ? 'lượng' : inv.type === 'crypto' ? 'coin' : 'cp';

  // Ẩn price change khi đang hidden để không lộ lời/lỗ
  const priceChangeHtml = (() => {
    if (inv.hidden) return '';
    const pd = priceCache[inv.id];
    if (!pd) return '';
    const ch = pd.change ?? 0;
    const chPct = pd.changePercent ?? 0;
    if (ch === 0 && chPct === 0) return '';
    const dir = ch >= 0 ? 'up' : 'down';
    const s = ch >= 0 ? '▲' : '▼';
    return `<div class="ic-price-change ${dir}">${s} ${fmtVND(Math.abs(ch))} (${Math.abs(chPct).toFixed(2)}%)</div>`;
  })();

  return `<div class="invest-card ${cls}${inv.hidden ? ' is-hidden' : ''}" data-id="${inv.id}">
    <div class="ic-icon ${inv.type}">${icon}</div>

    <div class="ic-info">
      <div class="ic-header">
        <span class="ic-symbol">${inv.symbol}</span>
        <span class="ic-badge ${badgeClass}">${typeMap[inv.type] || inv.type}</span>
        ${inv.notes ? `<span class="ic-notes" title="${inv.notes.replace(/"/g, '&quot;')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span>` : ''}
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
        ${c.hasPrice ? fmtVND(c.currentPrice) : (inv.type === 'gold' ? '✏️ Nhập giá bên trên' : '⏳ Đang tải...')}
      </div>
      ${priceChangeHtml}
      ${priceCache[inv.id]?.source ? `<div class="ic-source">${priceCache[inv.id].source === 'Nhập thủ công' ? '✏️' : '📡'} ${priceCache[inv.id].source}</div>` : ''}
    </div>

    <!-- PnL -->
    <div class="ic-pnl">
      ${inv.hidden
        ? `<div class="ic-hold-tag">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            Giữ dài hạn
          </div>`
        : `<div class="ic-pnl-value ${cls}">
            ${c.hasPrice ? `${sign}${fmtVNDShort(c.pnl)}` : '–'}
          </div>
          <div class="ic-pnl-pct ${cls}">
            ${c.pnlPct !== null ? `${sign}${c.pnlPct.toFixed(2)}%` : '–'}
          </div>
          ${c.hasPrice ? `<div class="ic-total-value">≈ ${fmtVNDShort(c.currentValue)}</div>` : ''}`
      }
    </div>

    <!-- Actions -->
    <div class="ic-actions">
      <button class="action-btn hide-toggle ${inv.hidden ? 'active' : ''}" onclick="toggleHide('${inv.id}')" title="${inv.hidden ? 'Bỏ ẩn' : 'Ẩn khoản này'}">
        ${inv.hidden
          ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
        }
      </button>
      <button class="action-btn edit" onclick="openEditModal('${inv.id}')" title="Sửa">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="action-btn del" onclick="openDeleteModal('${inv.id}')" title="Xóa">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
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
// TOGGLE HIDE
// ──────────────────────────────
async function toggleHide(id) {
  const inv = portfolio.investments.find(x => x.id === id);
  if (!inv) return;
  inv.hidden = !inv.hidden;
  await savePortfolio();
  renderAll();
  showToast(
    inv.hidden ? '🙈 Đã ẩn – hiện Giữ dài hạn' : '👁️ Đã hiện lại khoản đầu tư',
    'info'
  );
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
// PAGE NAVIGATION
// ──────────────────────────────
function navigateTo(page) {
  currentPage = page;
  const pageMain       = document.getElementById('page-main');
  const pageForecast   = document.getElementById('page-forecast');
  const pageGoldHealth = document.getElementById('page-gold-health');
  const addBtn         = document.getElementById('addBtn');
  const pageDateEl     = document.querySelector('.page-title');

  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

  if (page === 'main') {
    if (pageMain)       pageMain.style.display       = '';
    if (pageForecast)   pageForecast.style.display   = 'none';
    if (pageGoldHealth) pageGoldHealth.style.display = 'none';
    document.getElementById('navMain')?.classList.add('active');
    if (pageDateEl) pageDateEl.textContent = 'Danh Mục Đầu Tư';
    if (addBtn) addBtn.style.display = '';
  } else if (page === 'forecast') {
    if (pageMain)       pageMain.style.display       = 'none';
    if (pageForecast)   pageForecast.style.display   = '';
    if (pageGoldHealth) pageGoldHealth.style.display = 'none';
    document.getElementById('navForecast')?.classList.add('active');
    if (pageDateEl) pageDateEl.textContent = 'Dự báo AI';
    if (addBtn) addBtn.style.display = 'none';
  } else if (page === 'gold-health') {
    if (pageMain)       pageMain.style.display       = 'none';
    if (pageForecast)   pageForecast.style.display   = 'none';
    if (pageGoldHealth) pageGoldHealth.style.display = '';
    document.getElementById('navGoldHealth')?.classList.add('active');
    if (pageDateEl) pageDateEl.textContent = 'Sức khỏe Thị trường Vàng';
    if (addBtn) addBtn.style.display = 'none';
    loadGoldHealth();
  }
}

// ──────────────────────────────
// FORECAST – INIT
// ──────────────────────────────
function initForecastPage() {
  const sel = document.getElementById('forecastMonthSel');
  if (!sel || sel.options.length > 0) return;

  const now = new Date();
  const monthNames = ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6',
                      'Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12'];

  for (let i = 1; i <= 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const m = d.getMonth() + 1;
    const y = d.getFullYear();
    const opt = document.createElement('option');
    opt.value = `${y}-${String(m).padStart(2, '0')}`;
    opt.textContent = `${monthNames[m - 1]} ${y}`;
    sel.appendChild(opt);
  }
}

// ──────────────────────────────
// FORECAST – RUN
// ──────────────────────────────
async function runForecast() {
  const sel      = document.getElementById('forecastMonthSel');
  const modelSel = document.getElementById('forecastModelSel');
  const loadEl   = document.getElementById('forecastLoading');
  const resultEl = document.getElementById('forecastResult');
  const btnEl    = document.getElementById('runForecastBtn');
  const noticeEl = document.getElementById('fcApiNotice');

  if (!sel.value) { showToast('Vui lòng chọn tháng dự báo', 'error'); return; }
  if (!portfolio.investments.length) { showToast('Danh mục trống', 'error'); return; }

  const [year, month] = sel.value.split('-').map(Number);
  const model = modelSel.value;

  // Reset UI
  if (noticeEl) noticeEl.style.display = 'none';
  loadEl.style.display = 'flex';
  resultEl.style.display = 'none';
  btnEl.disabled = true;
  const btnSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="svg-spin"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`;
  btnEl.innerHTML = `${btnSvg}<span>Đang phân tích...</span>`;

  // Loading messages rotation
  const loadMsgs = [
    'Đang thu thập dữ liệu thị trường...',
    'Phân tích xu hướng ngành và kinh tế vĩ mô...',
    'Gemini AI đang tính toán dự báo giá...',
    'Đánh giá rủi ro và kịch bản thị trường...',
    'Hoàn thiện báo cáo dự báo...'
  ];
  let msgIdx = 0;
  const msgEl = document.getElementById('forecastLoadingMsg');
  const msgTimer = setInterval(() => {
    if (msgEl) msgEl.textContent = loadMsgs[++msgIdx % loadMsgs.length];
  }, 3500);

  try {
    const currentPrices = {};
    for (const [id, data] of Object.entries(priceCache)) {
      currentPrices[id] = data;
    }

    const res = await fetch('/api/forecast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        investments: portfolio.investments,
        currentPrices,
        targetMonth: month,
        targetYear: year,
        model
      })
    });

    const data = await res.json();

    if (!res.ok) {
      if (data.error?.includes('GEMINI_API_KEY') || data.error?.includes('API key')) {
        if (noticeEl) noticeEl.style.display = 'flex';
        showToast('❌ Cần cấu hình Gemini API Key', 'error');
      } else {
        showToast(`❌ ${data.error || 'Lỗi không xác định'}`, 'error');
      }
      return;
    }

    renderForecastResult(data);
    resultEl.style.display = 'block';
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('✅ Dự báo AI hoàn thành!', 'success');

  } catch (e) {
    console.error('[forecast]', e);
    showToast(`❌ Lỗi kết nối: ${e.message}`, 'error');
  } finally {
    clearInterval(msgTimer);
    loadEl.style.display = 'none';
    btnEl.disabled = false;
    btnEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><span>Dự báo ngay</span>`;
  }
}

// ──────────────────────────────
// FORECAST – RENDER RESULT
// ──────────────────────────────
function renderForecastResult(data) {
  const monthNames = ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6',
                      'Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12'];

  // Banner
  const monthLabel = `${monthNames[(data.forecastMonth || 1) - 1]} ${data.forecastYear || ''}`;
  setEl('fmbMonth', monthLabel);
  const modelName = document.getElementById('forecastModelSel')?.selectedOptions[0]?.text || '';
  setEl('fmbModel', modelName);

  // Calculate totals
  let totalCost = 0, totalForecastValue = 0, totalCurrentValue = 0, hasCurrentPrices = 0;
  const items = data.items || [];
  for (const item of items) {
    const qty = item.quantity || 0;
    totalCost          += qty * (item.purchasePrice || 0);
    totalForecastValue += qty * (item.forecastPrice || 0);
    if (item.currentPrice) {
      totalCurrentValue += qty * item.currentPrice;
      hasCurrentPrices++;
    }
  }

  const fcPnL    = totalForecastValue - totalCost;
  const fcPnLPct = totalCost > 0 ? (fcPnL / totalCost) * 100 : 0;
  const changeVsCurrent = (hasCurrentPrices > 0 && totalCurrentValue > 0)
    ? ((totalForecastValue - totalCurrentValue) / totalCurrentValue) * 100
    : null;

  // Summary cards
  setEl('fcTotalValue', fmtVND(totalForecastValue));
  setEl('fcTotalCost', fmtVND(totalCost));

  const pnlEl   = document.getElementById('fcTotalPnL');
  const pnlIcon = document.getElementById('fcPnLIcon');
  if (pnlEl) {
    const isProfit = fcPnL >= 0;
    const sign = isProfit ? '+' : '';
    pnlEl.innerHTML = `${sign}${fmtVND(fcPnL)}<br><small style="font-size:12px;font-weight:500">${sign}${fcPnLPct.toFixed(2)}%</small>`;
    pnlEl.style.color = isProfit ? 'var(--green)' : 'var(--red)';
    if (pnlIcon) pnlIcon.className = `summary-icon ${isProfit ? 'icon-green' : 'icon-red'}`;
  }

  const changeEl = document.getElementById('fcChangeVsCurrent');
  if (changeEl) {
    if (changeVsCurrent !== null) {
      const sign = changeVsCurrent >= 0 ? '+' : '';
      changeEl.textContent = `${sign}${changeVsCurrent.toFixed(2)}%`;
      changeEl.style.color = changeVsCurrent >= 0 ? 'var(--green)' : 'var(--red)';
    } else {
      changeEl.textContent = '–';
    }
  }

  // Outlook
  setEl('fcMarketOutlook', data.marketOutlook || '–');

  // Risks
  const risksWrap = document.getElementById('fcRisksWrap');
  if (risksWrap) {
    risksWrap.style.display = data.risks ? '' : 'none';
    if (data.risks) setEl('fcRisks', data.risks);
  }

  // Disclaimer
  setEl('fcDisclaimer', data.disclaimer || 'Dự báo chỉ mang tính tham khảo, không phải lời khuyên đầu tư.');

  // Table + mobile cards
  renderForecastTable(items);
}

function renderForecastTable(items) {
  const tbody = document.getElementById('fcTableBody');
  if (!tbody) return;

  const typeMap  = { stock: 'CP', gold: 'Vàng', crypto: 'Crypto', other: 'Khác' };
  const badgeMap = { stock: 'badge-stock', gold: 'badge-gold', crypto: 'badge-crypto', other: 'badge-other' };

  const trendHtmlMap = {
    'tăng':     `<span class="trend-badge trend-up">↑ Tăng</span>`,
    'giảm':     `<span class="trend-badge trend-down">↓ Giảm</span>`,
    'đi ngang': `<span class="trend-badge trend-flat">→ Đi ngang</span>`
  };
  const confClassMap = { 'cao': 'conf-high', 'trung bình': 'conf-mid', 'thấp': 'conf-low' };

  tbody.innerHTML = items.map((item, i) => {
    const qty          = item.quantity || 0;
    const buyPrice     = item.purchasePrice || 0;
    const curPrice     = item.currentPrice || null;
    const fcPrice      = item.forecastPrice || 0;
    const chgPct       = typeof item.changePercent === 'number' ? item.changePercent : 0;
    const fcValue      = qty * fcPrice;
    const fcPnL        = fcValue - (qty * buyPrice);
    const fcPnLPct     = buyPrice > 0 ? ((fcPrice - buyPrice) / buyPrice) * 100 : 0;
    const unitLabel    = item.type === 'gold' ? 'lượng' : item.type === 'crypto' ? 'coin' : 'cp';

    const chgColor  = chgPct >= 0 ? 'var(--green)' : 'var(--red)';
    const chgSign   = chgPct >= 0 ? '+' : '';
    const pnlColor  = fcPnL >= 0 ? 'var(--green)' : 'var(--red)';
    const pnlSign   = fcPnL >= 0 ? '+' : '';

    const trendHtml = trendHtmlMap[item.trend] || `<span class="trend-badge trend-flat">${item.trend || '–'}</span>`;
    const confClass = confClassMap[item.confidence] || 'conf-low';
    const confHtml  = `<span class="conf-badge ${confClass}">${item.confidence || '–'}</span>`;

    const upsideDownside = (item.upside && item.downside)
      ? `<div class="fc-scenarios">🔼 ${fmtVND(item.upside)} &nbsp;|&nbsp; 🔽 ${fmtVND(item.downside)}</div>`
      : '';

    return `<tr>
      <td class="fc-num">${i + 1}</td>
      <td>
        <div class="fc-cell-name">
          <span class="fc-symbol">${item.symbol}</span>
          <span class="fc-name-text">${item.name || ''}</span>
          ${upsideDownside}
        </div>
      </td>
      <td><span class="ic-badge ${badgeMap[item.type] || ''}">${typeMap[item.type] || item.type}</span></td>
      <td class="num">${fmtNum(qty)} ${unitLabel}</td>
      <td class="num">${fmtVND(buyPrice)}</td>
      <td class="num">${curPrice ? fmtVND(curPrice) : '<span style="color:var(--text-3)">–</span>'}</td>
      <td class="num fc-price-cell">${fmtVND(fcPrice)}</td>
      <td class="num" style="color:${chgColor};font-weight:600">${chgSign}${chgPct.toFixed(2)}%</td>
      <td class="num">${fmtVND(fcValue)}</td>
      <td class="num" style="color:${pnlColor}">
        ${pnlSign}${fmtVNDShort(fcPnL)}<br>
        <small style="font-size:11px">${pnlSign}${fcPnLPct.toFixed(2)}%</small>
      </td>
      <td>${trendHtml}</td>
      <td>${confHtml}</td>
      <td class="fc-reasoning-cell">${item.reasoning || '–'}</td>
    </tr>`;
  }).join('');

  // Mobile cards
  renderForecastMobileCards(items);
}

function renderForecastMobileCards(items) {
  const container = document.getElementById('fcMobileCards');
  if (!container) return;

  const confClassMap = { 'cao': 'conf-high', 'trung bình': 'conf-mid', 'thấp': 'conf-low' };
  const trendHtmlMap = {
    'tăng':     `<span class="trend-badge trend-up">↑ Tăng</span>`,
    'giảm':     `<span class="trend-badge trend-down">↓ Giảm</span>`,
    'đi ngang': `<span class="trend-badge trend-flat">→ Đi ngang</span>`
  };
  const typeIconFn = (type) => typeIcon(type, '');

  container.innerHTML = items.map(item => {
    const qty     = item.quantity || 0;
    const buyP    = item.purchasePrice || 0;
    const fcP     = item.forecastPrice || 0;
    const chgPct  = typeof item.changePercent === 'number' ? item.changePercent : 0;
    const fcValue = qty * fcP;
    const fcPnL   = fcValue - qty * buyP;
    const fcPnLPct = buyP > 0 ? ((fcP - buyP) / buyP * 100) : 0;
    const chgColor = chgPct >= 0 ? 'var(--green)' : 'var(--red)';
    const pnlColor = fcPnL >= 0 ? 'var(--green)' : 'var(--red)';
    const chgSign  = chgPct >= 0 ? '+' : '';
    const pnlSign  = fcPnL >= 0 ? '+' : '';
    const confClass = confClassMap[item.confidence] || 'conf-low';
    const trendHtml = trendHtmlMap[item.trend] || `<span class="trend-badge trend-flat">${item.trend || '–'}</span>`;

    return `<div class="fc-mobile-card">
      <div class="fc-mc-header">
        <div class="ic-icon ${item.type}">${typeIconFn(item.type)}</div>
        <div class="fc-mc-title">
          <span class="fc-symbol">${item.symbol}</span>
          <span class="fc-name-text">${item.name || ''}</span>
        </div>
        <div class="fc-mc-badges">
          ${trendHtml}
          <span class="conf-badge ${confClass}">${item.confidence || '–'}</span>
        </div>
      </div>
      <div class="fc-mc-grid">
        <div class="fc-mc-row">
          <span class="fc-mc-label">Giá dự báo</span>
          <span class="fc-mc-value fc-price-cell">${fmtVND(fcP)}</span>
        </div>
        <div class="fc-mc-row">
          <span class="fc-mc-label">Thay đổi</span>
          <span class="fc-mc-value" style="color:${chgColor}">${chgSign}${chgPct.toFixed(2)}%</span>
        </div>
        <div class="fc-mc-row">
          <span class="fc-mc-label">Giá trị dự báo</span>
          <span class="fc-mc-value">${fmtVNDShort(fcValue)}</span>
        </div>
        <div class="fc-mc-row">
          <span class="fc-mc-label">Lời / Lỗ</span>
          <span class="fc-mc-value" style="color:${pnlColor}">${pnlSign}${fmtVNDShort(fcPnL)} (${pnlSign}${fcPnLPct.toFixed(2)}%)</span>
        </div>
      </div>
      ${item.reasoning ? `<div class="fc-mc-reasoning">${item.reasoning}</div>` : ''}
      ${(item.upside && item.downside) ? `<div class="fc-mc-scenarios">🔼 ${fmtVND(item.upside)} &nbsp;|&nbsp; 🔽 ${fmtVND(item.downside)}</div>` : ''}
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════
// GOLD HEALTH PAGE
// ══════════════════════════════════════════════

let ghDataCache = null;
let ghLoadingLock = false;

async function loadGoldHealth(forceRefresh = false) {
  if (ghLoadingLock) return;
  if (ghDataCache && !forceRefresh) { renderGoldHealth(ghDataCache); return; }

  ghLoadingLock = true;
  const btn = document.getElementById('ghRefreshBtn');
  const icon = document.getElementById('ghRefreshIcon');
  if (btn) btn.disabled = true;
  if (icon) icon.classList.add('svg-spin');
  setEl('ghLastUpdated', '⏳ Đang tải dữ liệu...');

  try {
    const res = await fetch('/api/gold-health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    ghDataCache = data;
    renderGoldHealth(data);
    setEl('ghLastUpdated', `Cập nhật lúc ${new Date().toLocaleTimeString('vi-VN')}`);
    showToast('✅ Đã tải dữ liệu sức khỏe vàng', 'success');
  } catch (e) {
    setEl('ghLastUpdated', `❌ Lỗi: ${e.message}`);
    showToast(`❌ Không tải được dữ liệu: ${e.message}`, 'error');
  } finally {
    ghLoadingLock = false;
    if (btn) btn.disabled = false;
    if (icon) icon.classList.remove('svg-spin');
  }
}

// ── Render toàn bộ trang Gold Health ──
function renderGoldHealth(data) {
  // Scorecard
  renderGHScorecard(data);
  // Outlook
  renderGHOutlook(data);
  // Individual charts
  renderGHChart('gold', data.gold, '#F59E0B', 'USD/oz', signalGold);
  renderGHChart('dxy',  data.dxy,  '#3B82F6', 'pts',    signalDxy);
  renderGHChart('tnx',  data.tnx,  '#8B5CF6', '%',      signalTnx);
  renderGHChart('eur',  data.eur,  '#10B981', '',        signalEur);
  renderGHChart('vix',  data.vix,  '#EF4444', 'pts',    signalVix);
  renderGHChart('gsr',  data.gsr,  '#F97316', 'x',      signalGsr);
  renderGHChart('gld',  data.gld,  '#84CC16', 'USD',    signalGld);
  renderGHChart('oil',  data.oil,  '#06B6D4', 'USD/bbl',signalOil);
  // Correlation chart
  renderGHCorrChart(data);
}

// ── Signal functions ──
function signalGold(d) {
  const p = d?.data?.price; if (!p) return null;
  if (p > 3500) return { text: `${fmtNum(Math.round(p))} $ — Tăng cao`, color: 'green' };
  if (p > 2800) return { text: `${fmtNum(Math.round(p))} $ — Ổn định cao`, color: 'green' };
  if (p > 2200) return { text: `${fmtNum(Math.round(p))} $ — Trung tính`, color: 'yellow' };
  return { text: `${fmtNum(Math.round(p))} $ — Thấp`, color: 'red' };
}
function signalDxy(d) {
  const p = d?.data?.price; if (!p) return null;
  if (p > 105) return { text: `${p.toFixed(2)} — USD rất mạnh ⚠️`, color: 'red' };
  if (p > 100) return { text: `${p.toFixed(2)} — USD mạnh`, color: 'yellow' };
  if (p > 95)  return { text: `${p.toFixed(2)} — USD trung tính`, color: 'yellow' };
  return { text: `${p.toFixed(2)} — USD yếu ✅`, color: 'green' };
}
function signalTnx(d) {
  const p = d?.data?.price; if (!p) return null;
  if (p > 5.0) return { text: `${p.toFixed(2)}% — Rất cao ⚠️`, color: 'red' };
  if (p > 4.0) return { text: `${p.toFixed(2)}% — Cao`, color: 'yellow' };
  if (p > 3.0) return { text: `${p.toFixed(2)}% — Bình thường`, color: 'yellow' };
  return { text: `${p.toFixed(2)}% — Thấp ✅`, color: 'green' };
}
function signalEur(d) {
  const p = d?.data?.price; if (!p) return null;
  if (p > 1.15) return { text: `${p.toFixed(4)} — EUR mạnh ✅`, color: 'green' };
  if (p > 1.05) return { text: `${p.toFixed(4)} — Trung tính`, color: 'yellow' };
  return { text: `${p.toFixed(4)} — EUR yếu`, color: 'red' };
}
function signalVix(d) {
  const p = d?.data?.price; if (!p) return null;
  if (p > 35)  return { text: `${p.toFixed(1)} — Hoảng loạn 🔥`, color: 'green' };
  if (p > 20)  return { text: `${p.toFixed(1)} — Lo ngại`, color: 'yellow' };
  return { text: `${p.toFixed(1)} — Bình tĩnh`, color: 'yellow' };
}
function signalGsr(d) {
  const p = d?.data?.price; if (!p) return null;
  if (p > 90)  return { text: `${p.toFixed(1)}x — Vàng rất đắt`, color: 'yellow' };
  if (p > 80)  return { text: `${p.toFixed(1)}x — Vàng cao ⚠️`, color: 'yellow' };
  if (p > 60)  return { text: `${p.toFixed(1)}x — Bình thường`, color: 'green' };
  return { text: `${p.toFixed(1)}x — Vàng rẻ tương đối`, color: 'green' };
}
function signalGld(d) {
  const p = d?.data?.price; if (!p) return null;
  const chg = d?.data?.changePct || 0;
  if (chg > 1)  return { text: `$${p.toFixed(2)} — Dòng tiền vào ✅`, color: 'green' };
  if (chg > 0)  return { text: `$${p.toFixed(2)} — Tăng nhẹ`, color: 'green' };
  if (chg > -1) return { text: `$${p.toFixed(2)} — Ổn định`, color: 'yellow' };
  return { text: `$${p.toFixed(2)} — Dòng tiền ra`, color: 'red' };
}
function signalOil(d) {
  const p = d?.data?.price; if (!p) return null;
  if (p > 90)  return { text: `$${p.toFixed(1)}/bbl — Cao (lạm phát)`, color: 'green' };
  if (p > 70)  return { text: `$${p.toFixed(1)}/bbl — Trung bình`, color: 'yellow' };
  return { text: `$${p.toFixed(1)}/bbl — Thấp`, color: 'red' };
}

// ── Outlook / Nhận định ──
function renderGHOutlook(data) {
  const el = document.getElementById('ghOutlookCard');
  if (!el) return;

  const factors = [];
  let totalScore = 0;

  // DXY
  const dxy = data.dxy?.data?.price;
  if (dxy != null) {
    let sc, icon, desc;
    if (dxy < 100)      { sc = +2; icon = '✅'; desc = `DXY ${dxy.toFixed(2)} — USD yếu, hỗ trợ vàng tích cực`; }
    else if (dxy < 103) { sc = +1; icon = '↗️'; desc = `DXY ${dxy.toFixed(2)} — USD trung tính, không cản trở vàng`; }
    else if (dxy < 105) { sc = -1; icon = '⚠️'; desc = `DXY ${dxy.toFixed(2)} — USD mạnh, tạo áp lực lên vàng`; }
    else                { sc = -2; icon = '❌'; desc = `DXY ${dxy.toFixed(2)} — USD rất mạnh, cản trở vàng đáng kể`; }
    factors.push({ icon, desc, sc, label: 'DXY' }); totalScore += sc;
  }

  // US10Y
  const tnx = data.tnx?.data?.price;
  if (tnx != null) {
    let sc, icon, desc;
    if (tnx < 3.5)      { sc = +2; icon = '✅'; desc = `US10Y ${tnx.toFixed(2)}% — Lợi suất thấp, chi phí cơ hội giữ vàng thấp`; }
    else if (tnx < 4.0) { sc = +1; icon = '↗️'; desc = `US10Y ${tnx.toFixed(2)}% — Lợi suất vừa phải, ít cản trở vàng`; }
    else if (tnx < 4.5) { sc =  0; icon = '⚠️'; desc = `US10Y ${tnx.toFixed(2)}% — Lợi suất cao, giới hạn đà tăng vàng`; }
    else if (tnx < 5.0) { sc = -1; icon = '⚠️'; desc = `US10Y ${tnx.toFixed(2)}% — Lợi suất rất cao, áp lực lên vàng`; }
    else                { sc = -2; icon = '❌'; desc = `US10Y ${tnx.toFixed(2)}% — Lợi suất quá cao, cản trở vàng mạnh`; }
    factors.push({ icon, desc, sc, label: 'US10Y' }); totalScore += sc;
  }

  // VIX
  const vix = data.vix?.data?.price;
  if (vix != null) {
    let sc, icon, desc;
    if (vix > 35)       { sc = +2; icon = '✅'; desc = `VIX ${vix.toFixed(1)} — Hoảng loạn, dòng tiền tháo chạy vào vàng`; }
    else if (vix > 25)  { sc = +1; icon = '✅'; desc = `VIX ${vix.toFixed(1)} — Lo ngại, nhu cầu tài sản trú ẩn tăng`; }
    else if (vix > 15)  { sc =  0; icon = '↔️'; desc = `VIX ${vix.toFixed(1)} — Bình thường, tâm lý thị trường trung tính`; }
    else                { sc = -1; icon = '↘️'; desc = `VIX ${vix.toFixed(1)} — Tự tin cao, nhu cầu trú ẩn vào vàng giảm`; }
    factors.push({ icon, desc, sc, label: 'VIX' }); totalScore += sc;
  }

  // EUR/USD
  const eur = data.eur?.data?.price;
  if (eur != null) {
    let sc, icon, desc;
    if (eur > 1.15)     { sc = +1; icon = '✅'; desc = `EUR/USD ${eur.toFixed(4)} — EUR mạnh, USD suy yếu hỗ trợ vàng`; }
    else if (eur > 1.05){ sc =  0; icon = '↔️'; desc = `EUR/USD ${eur.toFixed(4)} — Tỷ giá EUR/USD trung tính`; }
    else                { sc = -1; icon = '⚠️'; desc = `EUR/USD ${eur.toFixed(4)} — EUR yếu, USD tương đối mạnh`; }
    factors.push({ icon, desc, sc, label: 'EUR/USD' }); totalScore += sc;
  }

  // Gold/Silver Ratio
  const gsr = data.gsr?.data?.price;
  if (gsr != null) {
    let sc, icon, desc;
    if (gsr > 90)       { sc = -1; icon = '⚠️'; desc = `GSR ${gsr.toFixed(1)}x — Vàng rất đắt so với bạc, thường điều chỉnh giảm`; }
    else if (gsr > 80)  { sc =  0; icon = '↔️'; desc = `GSR ${gsr.toFixed(1)}x — Vàng hơi đắt so với bạc, cần theo dõi`; }
    else if (gsr > 60)  { sc = +1; icon = '✅'; desc = `GSR ${gsr.toFixed(1)}x — Tỷ lệ vàng/bạc ở mức lịch sử hợp lý`; }
    else                { sc = +1; icon = '✅'; desc = `GSR ${gsr.toFixed(1)}x — Vàng rẻ tương đối, tiềm năng bắt kịp bạc`; }
    factors.push({ icon, desc, sc, label: 'Gold/Silver Ratio' }); totalScore += sc;
  }

  // GLD ETF
  const gldData = data.gld?.data;
  if (gldData != null) {
    const chg = gldData.changePct || 0;
    let sc, icon, desc;
    if (chg > 1)         { sc = +2; icon = '✅'; desc = `GLD ETF +${chg.toFixed(2)}% — Dòng tiền tổ chức đổ vào rất mạnh`; }
    else if (chg > 0)    { sc = +1; icon = '↗️'; desc = `GLD ETF +${chg.toFixed(2)}% — Dòng tiền tổ chức tích cực`; }
    else if (chg > -1)   { sc =  0; icon = '↔️'; desc = `GLD ETF ${chg.toFixed(2)}% — Dòng tiền tổ chức trung tính`; }
    else                 { sc = -1; icon = '⚠️'; desc = `GLD ETF ${chg.toFixed(2)}% — Tổ chức đang rút tiền khỏi vàng`; }
    factors.push({ icon, desc, sc, label: 'GLD ETF' }); totalScore += sc;
  }

  // WTI Oil
  const oil = data.oil?.data?.price;
  if (oil != null) {
    let sc, icon, desc;
    if (oil > 90)        { sc = +1; icon = '✅'; desc = `WTI $${oil.toFixed(1)}/bbl — Dầu cao, kỳ vọng lạm phát hỗ trợ vàng`; }
    else if (oil > 70)   { sc =  0; icon = '↔️'; desc = `WTI $${oil.toFixed(1)}/bbl — Giá dầu trung bình, lạm phát ổn định`; }
    else                 { sc = -1; icon = '↘️'; desc = `WTI $${oil.toFixed(1)}/bbl — Dầu thấp, kỳ vọng lạm phát yếu`; }
    factors.push({ icon, desc, sc, label: 'WTI Oil' }); totalScore += sc;
  }

  // ── Verdict ──
  let verdict, vClass, vIcon;
  const score = totalScore;
  if (score >= 7)       { verdict = 'TĂNG MẠNH';    vClass = 'ov-bull-strong'; vIcon = '🚀'; }
  else if (score >= 4)  { verdict = 'TĂNG NHẸ';     vClass = 'ov-bull';        vIcon = '📈'; }
  else if (score >= 1)  { verdict = 'TÍCH CỰC NHẸ'; vClass = 'ov-bull-weak';   vIcon = '↗️'; }
  else if (score === 0) { verdict = 'TRUNG TÍNH';   vClass = 'ov-neutral';     vIcon = '↔️'; }
  else if (score >= -3) { verdict = 'TIÊU CỰC NHẸ'; vClass = 'ov-bear-weak';   vIcon = '↘️'; }
  else if (score >= -6) { verdict = 'GIẢM NHẸ';     vClass = 'ov-bear';        vIcon = '📉'; }
  else                  { verdict = 'GIẢM MẠNH';    vClass = 'ov-bear-strong'; vIcon = '⬇️'; }

  // ── Narrative ──
  const goldPrice = data.gold?.data?.price;
  const goldPriceStr = goldPrice ? `$${fmtNum(Math.round(goldPrice))}/oz` : '';
  const bullFactors = factors.filter(f => f.sc > 0).map(f => f.label);
  const bearFactors = factors.filter(f => f.sc < 0).map(f => f.label);

  const parts = [];
  if (dxy != null && dxy < 100) parts.push(`USD đang suy yếu (DXY ${dxy.toFixed(2)})`);
  if (dxy != null && dxy > 103) parts.push(`USD đang mạnh (DXY ${dxy.toFixed(2)})`);
  if (vix != null && vix > 25) parts.push(`thị trường đang lo ngại (VIX ${vix.toFixed(1)})`);
  if (tnx != null && tnx < 3.5) parts.push(`lợi suất trái phiếu Mỹ thấp (${tnx.toFixed(2)}%)`);
  if (tnx != null && tnx >= 4.5) parts.push(`lợi suất trái phiếu Mỹ rất cao (${tnx.toFixed(2)}%)`);
  if (oil != null && oil > 90) parts.push(`giá dầu cao ($${oil.toFixed(1)}/bbl) đẩy kỳ vọng lạm phát`);
  if (gldData != null && gldData.changePct > 1) parts.push(`dòng tiền tổ chức đổ mạnh vào GLD ETF (+${gldData.changePct.toFixed(2)}%)`);
  if (eur != null && eur > 1.15) parts.push(`EUR/USD mạnh (${eur.toFixed(4)}) phản ánh USD yếu`);

  let narrative = `Vàng${goldPriceStr ? ` (${goldPriceStr})` : ''} đang nhận tín hiệu <strong>${verdict}</strong> trong ngắn hạn`;
  if (parts.length > 0) narrative += ` do ${parts.slice(0, 3).join(', ')}`;
  if (bearFactors.length > 0 && score > 0)
    narrative += `. ⚠️ Rủi ro cần theo dõi: ${bearFactors.join(', ')}`;
  else if (bullFactors.length > 0 && score <= 0)
    narrative += `. Yếu tố hỗ trợ còn lại: ${bullFactors.join(', ')}`;
  narrative += '.';

  // ── Score bar (normalize -9..+11 → 0..100%) ──
  const pct = Math.min(100, Math.max(0, Math.round(((score + 9) / 20) * 100)));

  el.innerHTML = `
    <div class="gh-ov-header">
      <div class="gh-ov-title-row">
        <span class="gh-ov-icon">🔮</span>
        <h3 class="gh-ov-title">Nhận định Sức khỏe Vàng</h3>
      </div>
      <div class="gh-ov-verdict ${vClass}">${vIcon} ${verdict}</div>
    </div>
    <p class="gh-ov-narrative">${narrative}</p>
    <div class="gh-ov-factors">
      ${factors.map(f => `
        <div class="gh-ov-factor">
          <span class="gh-of-icon">${f.icon}</span>
          <span class="gh-of-desc">${f.desc}</span>
          <span class="gh-of-sc ${f.sc > 0 ? 'pos' : f.sc < 0 ? 'neg' : 'neu'}">${f.sc > 0 ? '+' + f.sc : f.sc === 0 ? '±0' : f.sc}</span>
        </div>`).join('')}
    </div>
    <div class="gh-ov-bar-row">
      <span class="gh-ob-lbl bear">📉 GIẢM</span>
      <div class="gh-ov-bar">
        <div class="gh-ob-fill ${vClass}" style="width:${pct}%"></div>
        <div class="gh-ob-thumb" style="left:calc(${pct}% - 6px)"></div>
      </div>
      <span class="gh-ob-lbl bull">📈 TĂNG</span>
      <span class="gh-ob-total ${vClass}">Tổng điểm: ${score > 0 ? '+' : ''}${score}</span>
    </div>
  `;
}

// ── Scorecard ──
function renderGHScorecard(data) {
  const grid = document.getElementById('ghScorecardGrid');
  if (!grid) return;

  const cards = [
    { key: 'gold',  label: 'Vàng (GC=F)',     sigFn: signalGold,  icon: '🥇', group: 1 },
    { key: 'dxy',   label: 'DXY',              sigFn: signalDxy,   icon: '💵', group: 1 },
    { key: 'tnx',   label: 'US10Y Yield',      sigFn: signalTnx,   icon: '📈', group: 1 },
    { key: 'eur',   label: 'EUR/USD',           sigFn: signalEur,   icon: '🌐', group: 1 },
    { key: 'vix',   label: 'VIX',              sigFn: signalVix,   icon: '😱', group: 2 },
    { key: 'gsr',   label: 'Gold/Silver',       sigFn: signalGsr,   icon: '⚖️', group: 2 },
    { key: 'gld',   label: 'GLD ETF',          sigFn: signalGld,   icon: '📦', group: 3 },
    { key: 'oil',   label: 'WTI Oil',          sigFn: signalOil,   icon: '🛢️', group: 3 },
  ];

  grid.innerHTML = cards.map(c => {
    const d = data[c.key];
    const sig = c.sigFn(d);
    const chgPct = d?.data?.changePct;
    const chgSign = chgPct >= 0 ? '+' : '';
    const chgColor = chgPct >= 0 ? 'var(--green)' : 'var(--red)';
    const dotColor = sig?.color === 'green' ? 'var(--green)' : sig?.color === 'red' ? 'var(--red)' : 'var(--gold)';
    const groupBadge = `<span class="gh-sc-group g${c.group}">G${c.group}</span>`;

    return `<div class="gh-sc-card gh-sc-${sig?.color || 'yellow'}">
      <div class="gh-sc-top">
        <span class="gh-sc-icon">${c.icon}</span>
        ${groupBadge}
      </div>
      <div class="gh-sc-label">${c.label}</div>
      <div class="gh-sc-value">${sig?.text || '–'}</div>
      ${chgPct != null ? `<div class="gh-sc-chg" style="color:${chgColor}">${chgSign}${chgPct.toFixed(2)}% hôm nay</div>` : ''}
      <div class="gh-sc-indicator" style="background:${dotColor}"></div>
    </div>`;
  }).join('');
}

// ── Render từng chart ──
function renderGHChart(key, indicatorData, color, unit, sigFn) {
  const canvasId = `ghChart${key.charAt(0).toUpperCase() + key.slice(1)}`;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Badge
  const sig = sigFn(indicatorData);
  const badgeEl = document.getElementById(`ghBadge${key.charAt(0).toUpperCase() + key.slice(1)}`);
  if (badgeEl && sig) {
    badgeEl.textContent = sig.text;
    badgeEl.className = `gh-chart-badge badge-sig-${sig.color}`;
  }

  // Footer: change info
  const footerId = `ghFooter${key.charAt(0).toUpperCase() + key.slice(1)}`;
  const footerEl = document.getElementById(footerId);
  if (footerEl && indicatorData?.data) {
    const d = indicatorData.data;
    const sign = d.changePct >= 0 ? '▲' : '▼';
    const col = d.changePct >= 0 ? 'var(--green)' : 'var(--red)';
    const pts = d.points?.length || 0;
    footerEl.innerHTML = `<span>📡 ${d.shortName || key}</span> <span style="color:${col}">${sign} ${Math.abs(d.changePct || 0).toFixed(2)}% hôm nay</span> <span style="color:var(--text-3)">${pts} phiên</span>`;
  }

  if (!indicatorData?.data?.points?.length) {
    canvas.parentElement.insertAdjacentHTML('beforeend', '<div style="text-align:center;padding:20px;color:var(--text-3);font-size:12px">Không có dữ liệu</div>');
    return;
  }

  const points = indicatorData.data.points;
  const labels = points.map(p => {
    const d = new Date(p.date);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  });
  const values = points.map(p => p.close);

  // Gradient fill
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 200);
  grad.addColorStop(0, color + '40');
  grad.addColorStop(1, color + '00');

  // Destroy old chart if exists
  if (ghCharts[key]) { ghCharts[key].destroy(); delete ghCharts[key]; }

  // Tính min/max cho scale đẹp
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const pad = (maxVal - minVal) * 0.1 || 1;

  ghCharts[key] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: color,
        borderWidth: 2,
        backgroundColor: grad,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1E293B',
          borderColor: color,
          borderWidth: 1,
          callbacks: {
            label: ctx => ` ${ctx.parsed.y.toFixed(key === 'tnx' || key === 'eur' ? 3 : 1)} ${unit}`,
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,.04)' },
          ticks: {
            color: '#64748B', font: { size: 10 },
            maxTicksLimit: 8,
            maxRotation: 0
          },
          border: { color: 'rgba(255,255,255,.08)' }
        },
        y: {
          min: minVal - pad,
          max: maxVal + pad,
          grid: { color: 'rgba(255,255,255,.05)' },
          ticks: {
            color: '#64748B', font: { size: 10 },
            maxTicksLimit: 6,
            callback: v => {
              if (key === 'tnx') return v.toFixed(2) + '%';
              if (key === 'eur') return v.toFixed(3);
              if (key === 'gsr') return v.toFixed(1) + 'x';
              if (Math.abs(v) >= 1000) return (v/1000).toFixed(1) + 'k';
              return v.toFixed(1);
            }
          },
          border: { color: 'rgba(255,255,255,.08)' }
        }
      }
    }
  });
}

// ── Correlation chart: Gold vs DXY vs US10Y ──
function renderGHCorrChart(data) {
  const canvas = document.getElementById('ghChartCorr');
  if (!canvas) return;
  if (ghCharts['corr']) { ghCharts['corr'].destroy(); delete ghCharts['corr']; }

  const goldPts = data.gold?.data?.points || [];
  const dxyPts  = data.dxy?.data?.points  || [];
  const tnxPts  = data.tnx?.data?.points  || [];

  if (!goldPts.length) return;

  // Normalize to 100 at start for comparison
  function normalize(pts) {
    if (!pts.length) return [];
    const base = pts[0].close;
    return pts.map(p => ({ date: p.date, close: base > 0 ? (p.close / base) * 100 : 100 }));
  }

  const goldN = normalize(goldPts);
  const dxyN  = normalize(dxyPts);
  const tnxN  = normalize(tnxPts);

  // Use gold dates as X axis
  const labels = goldN.map(p => {
    const d = new Date(p.date);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  });

  // Build date maps for DXY and TNX
  const dxyMap = {}; dxyN.forEach(p => dxyMap[p.date] = p.close);
  const tnxMap = {}; tnxN.forEach(p => tnxMap[p.date] = p.close);

  const goldVals = goldN.map(p => parseFloat(p.close.toFixed(2)));
  const dxyVals  = goldN.map(p => dxyMap[p.date] != null ? parseFloat(dxyMap[p.date].toFixed(2)) : null);
  const tnxVals  = goldN.map(p => tnxMap[p.date] != null ? parseFloat(tnxMap[p.date].toFixed(2)) : null);

  const ctx = canvas.getContext('2d');
  ghCharts['corr'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '🥇 Vàng (GC=F)',
          data: goldVals,
          borderColor: '#F59E0B',
          borderWidth: 2.5,
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
        },
        {
          label: '💵 DXY (nghịch chiều)',
          data: dxyVals,
          borderColor: '#3B82F6',
          borderWidth: 2,
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
          borderDash: [5, 3],
        },
        {
          label: '📈 US10Y Yield',
          data: tnxVals,
          borderColor: '#8B5CF6',
          borderWidth: 2,
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
          borderDash: [2, 4],
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { color: '#94A3B8', font: { size: 11 }, boxWidth: 20, padding: 16 }
        },
        tooltip: {
          backgroundColor: '#1E293B',
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1)}%`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,.04)' },
          ticks: { color: '#64748B', font: { size: 10 }, maxTicksLimit: 10, maxRotation: 0 },
          border: { color: 'rgba(255,255,255,.08)' }
        },
        y: {
          grid: { color: 'rgba(255,255,255,.05)' },
          ticks: {
            color: '#64748B', font: { size: 10 },
            callback: v => v.toFixed(0) + '%'
          },
          border: { color: 'rgba(255,255,255,.08)' },
          title: { display: true, text: 'Chỉ số hóa (base=100)', color: '#64748B', font: { size: 10 } }
        }
      }
    }
  });
}

// ──────────────────────────────
// EVENTS
// ──────────────────────────────
function setupEventListeners() {
  // Navigation
  document.getElementById('navMain')?.addEventListener('click', e => {
    e.preventDefault(); navigateTo('main');
  });
  document.getElementById('navForecast')?.addEventListener('click', e => {
    e.preventDefault(); navigateTo('forecast');
  });
  document.getElementById('navGoldHealth')?.addEventListener('click', e => {
    e.preventDefault(); navigateTo('gold-health');
  });

  // Gold Health refresh button
  document.getElementById('ghRefreshBtn')?.addEventListener('click', () => {
    ghDataCache = null;
    loadGoldHealth(true);
  });
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

  // Gold price manual input
  const goldPriceBtn = document.getElementById('goldPriceBtn');
  const goldPriceInput = document.getElementById('goldPriceInput');
  if (goldPriceBtn) goldPriceBtn.addEventListener('click', saveGoldPrice);
  if (goldPriceInput) goldPriceInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveGoldPrice(); });

  // Forecast button
  document.getElementById('runForecastBtn')?.addEventListener('click', runForecast);

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
  if (type === 'gold') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="9" width="20" height="10" rx="2"/><path d="M6 9V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/></svg>`;
  if (type === 'crypto') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.767 19.089c4.924.868 6.14-6.025 1.216-6.894m-1.216 6.894L5.86 18.047m5.908 1.042-.347 1.97m1.563-8.864c4.924.869 6.14-6.025 1.215-6.893m-1.215 6.893-3.94-.694m5.155-6.2L8.29 4.26m5.908 1.042.348-1.97M7.48 20.364l3.126-17.727"/></svg>`;
  if (type === 'other') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;
  // Stock
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`;
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

// Nút refresh trên mobile bottom nav
const mobileRefBtn = document.getElementById('mobileRefreshBtn');
if (mobileRefBtn) {
  mobileRefBtn.addEventListener('click', async () => {
    const icon = mobileRefBtn.querySelector('svg');
    icon.classList.add('svg-spin');
    try {
      await fetchPrices();
      renderSummary();
      renderCharts();
      renderInvestments();
      showToast('✅ Đã cập nhật giá mới nhất', 'success');
    } finally {
      icon.classList.remove('svg-spin');
    }
  });
}
