const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
require('dotenv').config();

const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ────────────────────────────────────────────────
// Dữ liệu cục bộ (JSON fallback khi không có DATABASE_URL)
// ── Khai báo TRƯỚC initDB để tránh undefined ──
// ────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'portfolio.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Dữ liệu mẫu mặc định
const DEFAULT_DATA = {
  investments: [
    {
      id: '1',
      type: 'stock',
      symbol: 'FPT',
      name: 'FPT Corporation',
      quantity: 8200,
      purchasePrice: 99000,
      purchaseDate: '2024-01-15',
      notes: ''
    },
    {
      id: '2',
      type: 'gold',
      symbol: 'SJC',
      name: 'Vàng SJC 1 Lượng',
      quantity: 14,
      purchasePrice: 187800000,
      purchaseDate: '2024-03-01',
      notes: '14 cây vàng SJC'
    }
  ]
};

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf8');
}

// ────────────────────────────────────────────────
// Database connection (PostgreSQL – Railway)
// ────────────────────────────────────────────────
let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Bắt buộc cho Railway/Render
  });

  pool.on('error', (err) => {
    console.error('[DB] ❌ Lỗi PostgreSQL bất ngờ:', err.message);
  });
}

async function initDB() {
  if (!pool) {
    console.log('[DATABASE] ⚠️  Không có DATABASE_URL → dùng file JSON cục bộ.');
    return;
  }
  try {
    // Kiểm tra kết nối
    await pool.query('SELECT 1');
    console.log('[DATABASE] ✅ Kết nối PostgreSQL thành công!');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_portfolio (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const check = await pool.query('SELECT COUNT(*) FROM user_portfolio');
    if (parseInt(check.rows[0].count) === 0) {
      await pool.query('INSERT INTO user_portfolio (data) VALUES ($1)', [JSON.stringify(DEFAULT_DATA)]);
      console.log('[DATABASE] 📦 Đã tạo dữ liệu mặc định trong bảng user_portfolio.');
    }
    console.log('[DATABASE] 🎉 Database sẵn sàng!');
  } catch (err) {
    console.error('[DATABASE] ❌ Lỗi khởi tạo:', err.message);
  }
}
initDB();

// Đảm bảo thư mục data tồn tại
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Dữ liệu mẫu mặc định
const DEFAULT_DATA = {
  investments: [
    {
      id: '1',
      type: 'stock',
      symbol: 'FPT',
      name: 'FPT Corporation',
      quantity: 8200,
      purchasePrice: 99000,
      purchaseDate: '2024-01-15',
      notes: ''
    },
    {
      id: '2',
      type: 'gold',
      symbol: 'SJC',
      name: 'Vàng SJC 1 Lượng',
      quantity: 14,
      purchasePrice: 187800000,
      purchaseDate: '2024-03-01',
      notes: '14 cây vàng SJC'
    }
  ]
};

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf8');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ────────────────────────────────────────────────
// Hàm helper: Fetch với timeout (dùng built-in fetch của Node 18+)
// ────────────────────────────────────────────────
async function httpGet(url, extraHeaders = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        ...extraHeaders
      }
    });
    const data = await response.text();
    return { statusCode: response.status, data, headers: Object.fromEntries(response.headers) };
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────────────────────────────
// Trình lấy giá từ eodhd.com (Nhanh và chính xác cho Cổ phiếu VN & Vàng)
// ────────────────────────────────────────────────
const EODHD_API_TOKEN = process.env.EODHD_API_TOKEN || 'demo';

async function fetchStockEODHD(symbol) {
  if (!EODHD_API_TOKEN || EODHD_API_TOKEN === 'demo' || EODHD_API_TOKEN === 'YOUR_API_TOKEN') {
    // Nếu chưa có key eodhd thực, bỏ qua để fallback xuống Yahoo
    throw new Error('No valid EODHD Token');
  }
  
  let reqSymbol = symbol;
  if (!symbol.includes('.')) reqSymbol = `${symbol}.VN`;

  const url = `https://eodhd.com/api/real-time/${reqSymbol}?api_token=${EODHD_API_TOKEN}&fmt=json`;
  const res = await httpGet(url);
  const json = JSON.parse(res.data);
  if (!json || json.close === 'NA' || !json.close) throw new Error('No data from EODHD');

  const price = typeof json.close === 'number' ? json.close : parseFloat(json.close);
  const prevClose = typeof json.previousClose === 'number' ? json.previousClose : parseFloat(json.previousClose);
  const change = prevClose ? price - prevClose : 0;
  const changePercent = prevClose ? (change / prevClose) * 100 : 0;

  return {
    symbol, price, change, changePercent,
    open: json.open || 0,
    high: json.high || 0,
    low: json.low || 0,
    volume: json.volume || 0,
    currency: 'VND',
    source: `EODHD (${reqSymbol})`,
    lastUpdated: new Date((json.timestamp || Date.now() / 1000) * 1000).toISOString()
  };
}

// ────────────────────────────────────────────────
// Cache giá cổ phiếu trong server (tránh rate limit)
// ────────────────────────────────────────────────
const serverPriceCache = {};
const CACHE_TTL = 3 * 60 * 1000; // 3 phút

// Giá cổ phiếu – Yahoo Finance (VN stocks: FPT.VN)
async function fetchStockYahoo(symbol) {
  const suffixes = ['.VN', ''];
  for (const suffix of suffixes) {
    for (const host of ['query2', 'query1']) {
      try {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${symbol}${suffix}?interval=1d&range=2d&includePrePost=false`;
        const res = await httpGet(url, {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.9'
        });
        if (res.statusCode === 429 || res.data.includes('Too Many Requests')) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        const json = JSON.parse(res.data);
        if (!json.chart?.result?.[0]) continue;
        const meta = json.chart.result[0].meta;
        const quotes = json.chart.result[0].indicators?.quote?.[0];
        const price = meta.regularMarketPrice || 0;
        if (!price) continue;
        const closes = quotes?.close || [];
        const prevClose = closes.length >= 2 ? closes[closes.length - 2] : (meta.chartPreviousClose || 0);
        const change = prevClose ? price - prevClose : 0;
        const changePercent = prevClose ? (change / prevClose) * 100 : 0;
        return {
          symbol, price, change, changePercent,
          open: quotes?.open?.[quotes.open.length - 1] || 0,
          high: meta.regularMarketDayHigh || 0, low: meta.regularMarketDayLow || 0,
          volume: meta.regularMarketVolume || 0, currency: meta.currency || 'VND',
          source: `Yahoo (${symbol}${suffix})`, lastUpdated: new Date().toISOString()
        };
      } catch (e) {
        console.warn(`[STOCK] Yahoo ${host} ${symbol}${suffix}: ${e.message}`);
      }
    }
  }
  throw new Error('Yahoo Finance: no data');
}

async function getStockPrice(symbol) {
  const cached = serverPriceCache[`stock_${symbol}`];
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    console.log(`[STOCK] ${symbol} = ${cached.data.price.toLocaleString()} (cache)`);
    return cached.data;
  }
  
  // Ưu tiên dòng EODHD do người dùng gắn API Key, sau đó fallback xuống Yahoo
  const sources = [fetchStockEODHD, fetchStockYahoo];
  for (const fn of sources) {
    try {
      const result = await fn(symbol);
      if (result && result.price > 0) {
        console.log(`[STOCK] ${symbol} = ${result.price.toLocaleString()} (${result.source})`);
        serverPriceCache[`stock_${symbol}`] = { ts: Date.now(), data: result };
        return result;
      }
    } catch (e) {
      console.warn(`[STOCK] ${symbol} – ${fn.name}: ${e.message}`);
    }
  }
  
  return null;
}

// ────────────────────────────────────────────────
// Giá vàng – kết hợp EODHD và các nguồn khác
// ────────────────────────────────────────────────

// Nguồn 0: EODHD (PAXG-USD.CC)
async function fetchGoldEODHD() {
  if (!EODHD_API_TOKEN || EODHD_API_TOKEN === 'demo' || EODHD_API_TOKEN === 'YOUR_API_TOKEN') {
    throw new Error('No valid EODHD Token');
  }

  // Lấy giá PAXG-USD.CC từ EODHD (1 PAXG = 1 troy oz vàng)
  const xauRes = await httpGet(`https://eodhd.com/api/real-time/PAXG-USD.CC?api_token=${EODHD_API_TOKEN}&fmt=json`);
  const xauJson = JSON.parse(xauRes.data);
  const paxgUsd = typeof xauJson.close === 'number' ? xauJson.close : parseFloat(xauJson.close);
  if (!paxgUsd || isNaN(paxgUsd)) throw new Error('Invalid PAXG-USD price from EODHD');

  // Lấy USD/VND
  const usdRes = await httpGet('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', {
    'User-Agent': 'Mozilla/5.0'
  });
  const usdJson = JSON.parse(usdRes.data);
  const usdVnd = usdJson?.usd?.vnd;
  if (!usdVnd) throw new Error('Invalid USD/VND rate');

  // 1 lượng (cây) = 37.5g; 1 troy oz = 31.1034768g
  // Hệ số quy đổi 1 lượng = 37.5 / 31.1034768 ≈ 1.20565 troy oz
  const pricePerOzVnd = paxgUsd * usdVnd;
  const priceWorldPerLuongVnd = pricePerOzVnd * (37.5 / 31.1034768);
  
  // Vàng miếng SJC tại Việt Nam luôn có một độ chênh lệch (premium) rất cao so với giá thế giới.
  // Dựa trên dữ liệu thực tế (PAXG 5278.11 USD/oz → SJC ~ 184.000.000 VNĐ),
  // mức chênh lệch đang rơi vào khoảng 13.84%.
  const sjcPremiumMultiplier = 1.1384; 
  
  // Tính toán giá bán ra và làm tròn đến bước giá 10.000 VNĐ
  let finalPrice = priceWorldPerLuongVnd * sjcPremiumMultiplier;
  finalPrice = Math.round(finalPrice / 100000) * 100000; // Làm tròn theo bước giá 100.000 VNĐ

  console.log(`[GOLD-EODHD] PAXG=$${paxgUsd} × ${usdVnd} = ${pricePerOzVnd.toLocaleString()} → Giá thế giới: ${Math.round(priceWorldPerLuongVnd).toLocaleString()} → Giá SJC bán ra: ${finalPrice.toLocaleString()}`);
  return {
    symbol: 'SJC',
    buyPrice: finalPrice - 2000000, // Thường SJC mua vào thấp hơn bán ra khoảng 2-3 triệu/lượng
    sellPrice: finalPrice,
    price: finalPrice,
    priceWorld: Math.round(priceWorldPerLuongVnd),
    paxgUsd,
    usdVnd,
    source: `EODHD PAXG-USD.CC`,
    lastUpdated: new Date().toISOString()
  };
}

// Nguồn 1: Tỷ giá XAU/VND từ jsdelivr (currency-api miễn phí)
// XAU = 1 troy oz = 31.1035g; 1 lượng VN = 3.7500g
// Vàng SJC VN thường cao hơn giá thế giới khoảng 5–15%
async function fetchGoldFromCurrencyAPI() {
  const url = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xau.json';
  const res = await httpGet(url, {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const json = JSON.parse(res.data);
  const xauVnd = json?.xau?.vnd;
  if (!xauVnd || xauVnd < 1000000) throw new Error('Invalid XAU/VND rate');
  // 1 troy oz = 31.1035g ; 1 lượng vàng VN = 3.75g
  const pricePerLuong = (xauVnd / 31.1035) * 3.75;
  // SJC thường cao hơn giá thế giới ~8%
  const sjcPremium = 1.08;
  const sellPrice = Math.round(pricePerLuong * sjcPremium / 100000) * 100000;
  const buyPrice  = sellPrice - 500000;
  console.log(`[GOLD] XAU/VND=${xauVnd.toLocaleString()} → 1 lượng ≈ ${pricePerLuong.toLocaleString()} → SJC sell ≈ ${sellPrice.toLocaleString()}`);
  return { symbol: 'SJC', buyPrice, sellPrice, price: sellPrice, priceWorld: Math.round(pricePerLuong), source: 'XAU/VND (World)', lastUpdated: new Date().toISOString() };
}

// Nguồn 2: Yahoo Finance XAUUSD + USD/VND
async function fetchGoldFromYahooXAU() {
  const [xauRes, usdRes] = await Promise.all([
    httpGet('https://query2.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d', {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    }),
    httpGet('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    })
  ]);
  const xauJson = JSON.parse(xauRes.data);
  const usdJson = JSON.parse(usdRes.data);
  const xauUsd  = xauJson?.chart?.result?.[0]?.meta?.regularMarketPrice;
  const usdVnd  = usdJson?.usd?.vnd;
  if (!xauUsd || !usdVnd) throw new Error('No data');
  // xauUsd = USD/troy oz; usdVnd = VND per USD
  const xauVnd = xauUsd * usdVnd;
  const pricePerLuong = (xauVnd / 31.1035) * 3.75;
  const sjcPremium = 1.08;
  const sellPrice = Math.round(pricePerLuong * sjcPremium / 100000) * 100000;
  const buyPrice  = sellPrice - 500000;
  console.log(`[GOLD] XAU=$${xauUsd} × ${usdVnd} = ${xauVnd.toLocaleString()} → SJC≈${sellPrice.toLocaleString()}`);
  return { symbol: 'SJC', buyPrice, sellPrice, price: sellPrice, priceWorld: Math.round(pricePerLuong), xauUsd, usdVnd, source: `XAUUSD $${xauUsd.toFixed(0)} × ${usdVnd.toFixed(0)}`, lastUpdated: new Date().toISOString() };
}

async function getGoldPriceSJC() {
  const sources = [fetchGoldEODHD, fetchGoldFromCurrencyAPI, fetchGoldFromYahooXAU];
  for (const fn of sources) {
    try {
      const result = await fn();
      if (result && result.price > 0) return result;
    } catch (e) {
      console.warn(`[GOLD] ${fn.name}: ${e.message}`);
    }
  }
  return null;
}

// ────────────────────────────────────────────────
// REST API Endpoints
// ────────────────────────────────────────────────

// Lấy toàn bộ danh mục (Ưu tiên DB Railway -> Fallback JSON)
app.get('/api/portfolio', async (req, res) => {
  try {
    if (pool) {
      const dbRes = await pool.query('SELECT data FROM user_portfolio ORDER BY id DESC LIMIT 1');
      if (dbRes.rows.length > 0) return res.json(dbRes.rows[0].data);
    }
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    res.json(data);
  } catch (e) {
    console.error('[API] GET /api/portfolio lỗi:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Lưu danh mục (Lưu vào DB Railway -> Backup vào JSON)
app.post('/api/portfolio', async (req, res) => {
  try {
    if (pool) {
      await pool.query('UPDATE user_portfolio SET data = $1, updated_at = CURRENT_TIMESTAMP', [JSON.stringify(req.body)]);
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ success: true });
  } catch (e) {
    console.error('[API] POST /api/portfolio lỗi:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Endpoint kiểm tra tình trạng database
app.get('/api/db-status', async (req, res) => {
  if (!pool) return res.json({ connected: false, message: 'Không có DATABASE_URL, đang dùng JSON cục bộ.' });
  try {
    await pool.query('SELECT 1');
    const count = await pool.query('SELECT COUNT(*) FROM user_portfolio');
    res.json({ connected: true, rows: parseInt(count.rows[0].count), message: '✅ Database kết nối OK!' });
  } catch (e) {
    res.json({ connected: false, message: e.message });
  }
});

// Giá cổ phiếu đơn lẻ
app.get('/api/price/stock/:symbol', async (req, res) => {
  try {
    const price = await getStockPrice(req.params.symbol.toUpperCase());
    if (price) {
      res.json(price);
    } else {
      res.status(404).json({ error: `Không tìm thấy giá cho mã: ${req.params.symbol}` });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Giá vàng SJC
app.get('/api/price/gold/sjc', async (req, res) => {
  try {
    const price = await getGoldPriceSJC();
    if (price) {
      res.json(price);
    } else {
      res.status(404).json({ error: 'Không thể lấy giá vàng SJC' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cập nhật giá hàng loạt (batch) cho cả danh mục
app.post('/api/prices/batch', async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'items là bắt buộc' });
  }

  const results = {};
  const uniqueStocks = [...new Set(items.filter(i => i.type === 'stock').map(i => i.symbol))];
  const hasGold = items.some(i => i.type === 'gold' && i.symbol === 'SJC');

  // Fetch song song để nhanh hơn
  const fetchPromises = uniqueStocks.map(sym =>
    getStockPrice(sym).then(p => ({ sym, p })).catch(() => ({ sym, p: null }))
  );
  if (hasGold) {
    fetchPromises.push(getGoldPriceSJC().then(p => ({ sym: '__SJC__', p })).catch(() => ({ sym: '__SJC__', p: null })));
  }

  const fetched = await Promise.all(fetchPromises);
  const priceMap = {};
  for (const { sym, p } of fetched) {
    if (p) priceMap[sym] = p;
  }

  for (const item of items) {
    if (item.type === 'stock' && priceMap[item.symbol]) {
      results[item.id] = priceMap[item.symbol];
    } else if (item.type === 'gold' && item.symbol === 'SJC' && priceMap['__SJC__']) {
      results[item.id] = priceMap['__SJC__'];
    }
  }

  res.json(results);
});

// ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║  💼 Portfolio Tracker đang chạy        ║`);
  console.log(`║  → http://localhost:${PORT}               ║`);
  console.log(`╚════════════════════════════════════════╝\n`);
});
