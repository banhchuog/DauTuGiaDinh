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

  // Lấy giá XAUUSD.FOREX từ EODHD (đơn vị: USD/troy oz)
  const xauRes = await httpGet(`https://eodhd.com/api/real-time/XAUUSD.FOREX?api_token=${EODHD_API_TOKEN}&fmt=json`);
  const xauJson = JSON.parse(xauRes.data);
  const xauUsd = typeof xauJson.close === 'number' ? xauJson.close : parseFloat(xauJson.close);
  if (!xauUsd || isNaN(xauUsd) || xauUsd < 100) throw new Error(`Invalid XAUUSD price from EODHD: ${xauUsd}`);

  // Lấy USD/VND
  const usdRes = await httpGet('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', {
    'User-Agent': 'Mozilla/5.0'
  });
  const usdJson = JSON.parse(usdRes.data);
  const usdVnd = usdJson?.usd?.vnd;
  if (!usdVnd) throw new Error('Invalid USD/VND rate');

  // 1 cây VN = 37.5g ; 1 troy oz = 31.1034768g
  // Giá thế giới / cây (VND) + flat 20 triệu = giá SJC
  const SJC_FLAT_PREMIUM = 20_000_000;
  const xauVnd = xauUsd * usdVnd;
  const priceWorldPerLuong = xauVnd * (37.5 / 31.1034768);
  const finalPrice = Math.round((priceWorldPerLuong + SJC_FLAT_PREMIUM) / 100000) * 100000;

  console.log(`[GOLD-EODHD] XAUUSD=$${xauUsd} × ${usdVnd} → 1 cây TG: ${Math.round(priceWorldPerLuong).toLocaleString()} + 20tr = SJC: ${finalPrice.toLocaleString()}`);
  return {
    symbol: 'SJC',
    buyPrice: finalPrice - 2000000,
    sellPrice: finalPrice,
    price: finalPrice,
    priceWorld: Math.round(priceWorldPerLuong),
    xauUsd,
    usdVnd,
    source: `EODHD XAUUSD $${xauUsd.toFixed(0)}`,
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
  // 1 troy oz = 31.1035g ; 1 lượng vàng VN = 37.5g
  // Giá thế giới theo cây (VND) + flat 20 triệu = giá SJC
  const SJC_FLAT_PREMIUM = 20_000_000;
  const pricePerLuong = xauVnd * (37.5 / 31.1035);
  const sellPrice = Math.round((pricePerLuong + SJC_FLAT_PREMIUM) / 100000) * 100000;
  const buyPrice  = sellPrice - 500000;
  console.log(`[GOLD] XAU/VND=${xauVnd.toLocaleString()} → 1 cây: ${Math.round(pricePerLuong).toLocaleString()} + 20tr = SJC: ${sellPrice.toLocaleString()}`);
  return { symbol: 'SJC', buyPrice, sellPrice, price: sellPrice, priceWorld: Math.round(pricePerLuong), source: 'XAU/VND (World)', lastUpdated: new Date().toISOString() };
}

// Nguồn 2: Yahoo Finance XAUUSD=X (spot) + USD/VND
async function fetchGoldFromYahooXAU() {
  const [xauRes, usdRes] = await Promise.all([
    httpGet('https://query2.finance.yahoo.com/v8/finance/chart/XAUUSD%3DX?interval=1d&range=1d', {
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
  // Giá thế giới theo cây (VND) + flat 20 triệu = giá SJC
  const SJC_FLAT_PREMIUM = 20_000_000;
  const xauVnd = xauUsd * usdVnd;
  const pricePerLuong = xauVnd * (37.5 / 31.1035);
  const sellPrice = Math.round((pricePerLuong + SJC_FLAT_PREMIUM) / 100000) * 100000;
  const buyPrice  = sellPrice - 500000;
  console.log(`[GOLD-Yahoo] XAUUSD=$${xauUsd} × ${usdVnd} → 1 cây: ${Math.round(pricePerLuong).toLocaleString()} + 20tr = SJC: ${sellPrice.toLocaleString()}`);
  return { symbol: 'SJC', buyPrice, sellPrice, price: sellPrice, priceWorld: Math.round(pricePerLuong), xauUsd, usdVnd, source: `Yahoo XAUUSD $${xauUsd.toFixed(0)}`, lastUpdated: new Date().toISOString() };
}

async function getGoldPriceSJC() {
  // Ưu tiên: Yahoo XAUUSD=X (spot thực) → EODHD XAUUSD.FOREX → CurrencyAPI XAU/VND
  const sources = [fetchGoldFromYahooXAU, fetchGoldEODHD, fetchGoldFromCurrencyAPI];
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
// Gold Health – lấy dữ liệu lịch sử các chỉ số
// ────────────────────────────────────────────────
const goldHealthCache = {};
const GH_CACHE_TTL = 10 * 60 * 1000; // 10 phút

function httpsGetRaw(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
        'sec-ch-ua': '"Chromium";v="124"',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site'
      },
      timeout: 15000
    };
    const req = https.get(url, opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ statusCode: res.statusCode, data: body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchYahooHistory(symbol, range = '90d') {
  const enc = encodeURIComponent(symbol);
  for (const host of ['query2', 'query1']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=${range}&includePrePost=false&events=div%2Csplit`;
      const res = await httpsGetRaw(url);
      if (res.statusCode === 429 || res.data.startsWith('Too Many')) {
        console.warn(`[GH] ${symbol} ${host}: 429 Too Many Requests`);
        continue;
      }
      if (res.statusCode !== 200) {
        console.warn(`[GH] ${symbol} ${host}: HTTP ${res.statusCode}`);
        continue;
      }
      let json;
      try { json = JSON.parse(res.data); } catch(pe) {
        console.warn(`[GH] ${symbol} ${host}: JSON parse error`);
        continue;
      }
      const result = json?.chart?.result?.[0];
      if (!result) { console.warn(`[GH] ${symbol} ${host}: no result`); continue; }
      const timestamps = result.timestamp || [];
      const closes    = result.indicators?.quote?.[0]?.close || [];
      const volumes   = result.indicators?.quote?.[0]?.volume || [];
      const meta      = result.meta || {};
      const points = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] != null) {
          points.push({
            date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
            close: closes[i],
            volume: volumes[i] || 0
          });
        }
      }
      // Tính % ngày: dùng điểm lịch sử cuối cùng của ngày KHÁC ngày hôm nay
      // (Yahoo hay trùng điểm cuối — cần lọc theo date)
      const currentPrice = meta.regularMarketPrice || closes.filter(Boolean).slice(-1)[0] || 0;
      const lastDate = points.length ? points[points.length - 1].date : null;
      // Tìm điểm cuối cùng có ngày khác lastDate
      let prevDayClose = 0;
      for (let i = points.length - 2; i >= 0; i--) {
        if (points[i].date !== lastDate && points[i].close) {
          prevDayClose = points[i].close;
          break;
        }
      }
      // Fallback: regularMarketPreviousClose nếu có
      if (!prevDayClose && meta.regularMarketPreviousClose) prevDayClose = meta.regularMarketPreviousClose;
      const dayChange    = currentPrice && prevDayClose ? currentPrice - prevDayClose : 0;
      const dayChangePct = currentPrice && prevDayClose ? (dayChange / prevDayClose) * 100 : 0;
      console.log(`[GH] ✅ ${symbol} via ${host}: ${points.length} pts, price=${currentPrice}, prev=${prevDayClose?.toFixed(4)}, chg=${dayChangePct.toFixed(3)}%`);
      return {
        symbol,
        price: currentPrice,
        prevClose: prevDayClose,
        change: dayChange,
        changePct: dayChangePct,
        points,
        currency: meta.currency || '',
        shortName: meta.shortName || symbol,
        exchangeName: meta.exchangeName || ''
      };
    } catch (e) {
      console.warn(`[GH] ${symbol} ${host}: ${e.message}`);
    }
  }
  throw new Error(`Cannot fetch ${symbol}`);
}

app.get('/api/gold-health', async (req, res) => {
  const cacheKey = 'gold-health';
  if (goldHealthCache[cacheKey] && (Date.now() - goldHealthCache[cacheKey].ts) < GH_CACHE_TTL) {
    console.log('[GH] Trả từ cache');
    return res.json(goldHealthCache[cacheKey].data);
  }

  const INDICATORS = [
    { key: 'gold',  symbol: 'GC=F',      label: 'Vàng (GC=F)',       group: 1 },
    { key: 'dxy',   symbol: 'DX-Y.NYB',  label: 'DXY Dollar Index',  group: 1 },
    { key: 'tnx',   symbol: '^TNX',       label: 'US 10Y Yield',      group: 1 },
    { key: 'eur',   symbol: 'EURUSD=X',   label: 'EUR/USD',           group: 1 },
    { key: 'vix',   symbol: '^VIX',       label: 'VIX Fear Index',    group: 2 },
    { key: 'si',    symbol: 'SI=F',       label: 'Bạc (SI=F)',        group: 2 },
    { key: 'gld',   symbol: 'GLD',        label: 'GLD ETF',           group: 3 },
    { key: 'oil',   symbol: 'CL=F',       label: 'WTI Crude Oil',     group: 3 },
  ];

  try {
    const payload = {};
    for (const ind of INDICATORS) {
      try {
        const d = await fetchYahooHistory(ind.symbol, '90d');
        const { key, ...rest } = ind;
        payload[key] = { ...rest, data: d };
      } catch (e) {
        console.warn(`[GH] Bỏ qua ${ind.symbol}: ${e.message}`);
      }
      // Delay 600ms giữa các request để tránh rate-limit Yahoo
      await new Promise(r => setTimeout(r, 600));
    }

    // Tính Gold/Silver Ratio từ GC và SI
    if (payload.gold?.data?.points?.length && payload.si?.data?.points?.length) {
      const gcPoints = payload.gold.data.points;
      const siPoints = payload.si.data.points;
      // Ghép theo ngày gần nhất
      const siMap = {};
      for (const p of siPoints) siMap[p.date] = p.close;
      const gsrPoints = gcPoints
        .filter(p => siMap[p.date] && siMap[p.date] > 0)
        .map(p => ({ date: p.date, close: parseFloat((p.close / siMap[p.date]).toFixed(2)), volume: 0 }));
      const gsrLast = gsrPoints[gsrPoints.length - 1]?.close || 0;
      const gsrPrev = gsrPoints[gsrPoints.length - 2]?.close || 0;
      payload.gsr = {
        key: 'gsr', symbol: 'GSR', label: 'Gold/Silver Ratio', group: 2,
        data: {
          symbol: 'GSR', price: gsrLast, prevClose: gsrPrev,
          change: gsrLast - gsrPrev,
          changePct: gsrPrev ? ((gsrLast - gsrPrev) / gsrPrev) * 100 : 0,
          points: gsrPoints, currency: 'ratio', shortName: 'Gold/Silver Ratio'
        }
      };
    }

    if (Object.keys(payload).length > 0) {
      goldHealthCache[cacheKey] = { ts: Date.now(), data: payload };
    }
    res.json(payload);
    console.log('[GH] ✅ Đã lấy dữ liệu sức khỏe vàng:', Object.keys(payload).join(', '));
  } catch (e) {
    console.error('[GH] ❌', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────
// Gemini AI – Dự báo danh mục
// ────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

app.post('/api/forecast', async (req, res) => {
  try {
    const { investments, currentPrices, targetMonth, targetYear, model } = req.body;

    if (!GEMINI_API_KEY) {
      return res.status(400).json({
        error: 'GEMINI_API_KEY chưa được cấu hình. Vui lòng thêm GEMINI_API_KEY=your_key vào file .env rồi khởi động lại server. Lấy key miễn phí tại https://aistudio.google.com/app/apikey'
      });
    }
    if (!investments?.length) {
      return res.status(400).json({ error: 'Danh mục trống, không có gì để dự báo.' });
    }

    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear  = now.getFullYear();
    const monthsAhead = (targetYear - curYear) * 12 + (targetMonth - curMonth);

    if (monthsAhead <= 0) {
      return res.status(400).json({ error: 'Vui lòng chọn tháng trong tương lai.' });
    }

    const monthNamesVN = ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6',
                          'Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12'];
    const targetMonthName = `${monthNamesVN[targetMonth - 1]} năm ${targetYear}`;

    const typeMap = { stock: 'Cổ phiếu HOSE/VN', gold: 'Vàng (SJC)', crypto: 'Tiền điện tử', other: 'Tài sản khác' };

    const portfolioLines = investments.map(inv => {
      const cp = currentPrices?.[inv.id];
      const currentPrice = cp?.price || null;
      const costValue = inv.quantity * inv.purchasePrice;
      let lines = [`• ID="${inv.id}" | ${inv.symbol} | ${inv.name || ''} | ${typeMap[inv.type] || inv.type}`];
      lines.push(`  Số lượng: ${inv.quantity}`);
      lines.push(`  Giá mua vào: ${inv.purchasePrice.toLocaleString('vi-VN')}₫`);
      lines.push(`  Tổng vốn đầu tư: ${costValue.toLocaleString('vi-VN')}₫`);
      if (currentPrice) {
        const pnlPct = ((currentPrice - inv.purchasePrice) / inv.purchasePrice * 100).toFixed(2);
        lines.push(`  Giá hiện tại (${curMonth}/${curYear}): ${currentPrice.toLocaleString('vi-VN')}₫ (${pnlPct >= 0 ? '+' : ''}${pnlPct}%)`);
        lines.push(`  Giá trị hiện tại: ${(inv.quantity * currentPrice).toLocaleString('vi-VN')}₫`);
      } else {
        lines.push(`  Giá hiện tại: Chưa có (dùng giá mua để tham chiếu)`);
      }
      if (inv.purchaseDate) lines.push(`  Ngày mua: ${inv.purchaseDate}`);
      return lines.join('\n');
    }).join('\n\n');

    const prompt = `Bạn là chuyên gia phân tích tài chính đầu tư hàng đầu Việt Nam với 20+ năm kinh nghiệm. Bạn am hiểu sâu về thị trường chứng khoán HOSE/HNX, vàng SJC, tiền điện tử và các tài sản tài chính tại Việt Nam.

NHIỆM VỤ: Dự báo giá các khoản đầu tư trong danh mục vào ${targetMonthName} (khoảng ${monthsAhead} tháng kể từ ${curMonth}/${curYear}).

DANH MỤC HIỆN TẠI (${curMonth}/${curYear}):
${portfolioLines}

HƯỚNG DẪN PHÂN TÍCH:
- Cổ phiếu VN: phân tích ngành, tăng trưởng doanh nghiệp, chính sách tiền tệ NHNN, xu hướng HOSE/VNIndex
- Vàng SJC: giá vàng thế giới XAU/USD, USD/VND, chênh lệch SJC vs thế giới, nhu cầu trong nước
- Crypto: chu kỳ thị trường Bitcoin, các sự kiện halving, tâm lý nhà đầu tư toàn cầu
- Yếu tố vĩ mô: lạm phát, lãi suất FED và NHNN, địa chính trị, kinh tế Việt Nam

ĐỊNH DẠNG PHẢN HỒI (CHỈ JSON THUẦN TÚY — KHÔNG CÓ MARKDOWN, KHÔNG CÓ CODE BLOCK):
{
  "forecastMonth": ${targetMonth},
  "forecastYear": ${targetYear},
  "marketOutlook": "Nhận định tổng quan thị trường giai đoạn ${targetMonthName} — 2-3 câu bằng tiếng Việt",
  "items": [
    {
      "id": "EXACT_ID_CUA_KHOAN_DAU_TU",
      "symbol": "MA_CO_PHIEU",
      "forecastPrice": GIA_DU_BAO_SO_NGUYEN_VND,
      "trend": "tăng|giảm|đi ngang",
      "changePercent": SO_THUC_PHAN_TRAM_SO_VOI_GIA_HIEN_TAI,
      "confidence": "cao|trung bình|thấp",
      "reasoning": "Phân tích ngắn gọn 1-2 câu bằng tiếng Việt",
      "upside": GIA_KICH_BAN_TOT_SO_NGUYEN_VND,
      "downside": GIA_KICH_BAN_XAU_SO_NGUYEN_VND
    }
  ],
  "risks": "Các rủi ro chính cần theo dõi — 1-2 câu bằng tiếng Việt",
  "disclaimer": "Dự báo chỉ mang tính tham khảo, không phải lời khuyên đầu tư chuyên nghiệp."
}

QUY TẮC BẮT BUỘC:
- Chỉ trả về JSON thuần túy, không có bất kỳ text nào bên ngoài JSON
- "id" trong items phải khớp CHÍNH XÁC với ID từ danh mục (ký tự giống hệt)
- forecastPrice, upside, downside: số nguyên dương (VND, không có dấu phẩy hay ký tự)
- changePercent: số thực (ví dụ: 15.5 cho +15.5%, -8.3 cho -8.3%)
- Tất cả ${investments.length} khoản đầu tư phải xuất hiện trong mảng "items"`;

    const geminiModel = model || 'gemini-2.5-pro';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GEMINI_API_KEY}`;

    const reqBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json'
      }
    };

    console.log(`[FORECAST] ⏳ Gọi ${geminiModel} → dự báo ${targetMonthName}...`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000); // 2 phút timeout
    let geminiRes;
    try {
      geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      let errMsg = `Gemini API lỗi ${geminiRes.status}`;
      try {
        const errJson = JSON.parse(errText);
        errMsg += `: ${errJson.error?.message || errText}`;
      } catch { errMsg += `: ${errText.substring(0, 300)}`; }
      throw new Error(errMsg);
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!rawText) {
      const reason = geminiData.candidates?.[0]?.finishReason || 'unknown';
      throw new Error(`Gemini không trả về nội dung. Lý do: ${reason}`);
    }

    let forecastData;
    try {
      const clean = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      forecastData = JSON.parse(clean);
    } catch {
      const m = rawText.match(/\{[\s\S]*\}/);
      if (!m) throw new Error(`Không parse được JSON từ Gemini. Response: ${rawText.substring(0, 300)}`);
      forecastData = JSON.parse(m[0]);
    }

    // Enrich items với đầy đủ thông tin từ portfolio
    if (Array.isArray(forecastData.items)) {
      forecastData.items = forecastData.items.map(item => {
        const inv = investments.find(i => i.id === item.id) || investments.find(i => i.symbol === item.symbol);
        if (inv) {
          const cp = currentPrices?.[inv.id];
          return {
            ...item,
            id: inv.id,
            symbol: inv.symbol,
            name: inv.name || '',
            type: inv.type,
            quantity: inv.quantity,
            purchasePrice: inv.purchasePrice,
            currentPrice: cp?.price || null,
          };
        }
        return item;
      });
      // Thêm các khoản bị thiếu
      for (const inv of investments) {
        if (!forecastData.items.find(i => i.id === inv.id)) {
          const cp = currentPrices?.[inv.id];
          const ref = cp?.price || inv.purchasePrice;
          forecastData.items.push({
            id: inv.id, symbol: inv.symbol, name: inv.name || '', type: inv.type,
            quantity: inv.quantity, purchasePrice: inv.purchasePrice,
            currentPrice: cp?.price || null, forecastPrice: ref,
            trend: 'đi ngang', changePercent: 0, confidence: 'thấp',
            reasoning: 'Không đủ dữ liệu để dự báo chính xác.',
            upside: ref, downside: ref
          });
        }
      }
    }

    console.log(`[FORECAST] ✅ Hoàn thành — ${forecastData.items?.length || 0} khoản đầu tư`);
    res.json(forecastData);

  } catch (err) {
    console.error('[FORECAST] ❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║  💼 Portfolio Tracker đang chạy        ║`);
  console.log(`║  → http://localhost:${PORT}               ║`);
  console.log(`╚════════════════════════════════════════╝\n`);
});
