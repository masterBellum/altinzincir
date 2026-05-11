/**
 * fetch_current.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Her 5 dakikada GitHub Actions tarafından çalıştırılır.
 * Truncgil V3 (altın + döviz), Yahoo Finance (emtia + BIST) ve CoinGecko (kripto)
 * kaynaklarından anlık fiyatları çeker, data/current.json dosyasına yazar.
 *
 * App artık doğrudan API'lere istek atmaz — sadece bu dosyayı okur.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs            = require('fs');
const https         = require('https');
const path          = require('path');
const { spawnSync } = require('child_process');

const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'current.json');
const HISTORY_DIR = path.join(__dirname, '..', 'data', 'history');
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// ── Kaynak URL'leri ───────────────────────────────────────────────────────────
const TRUNCGIL_URL    = 'https://finans.truncgil.com/v3/today.json';
// canlidoviz.com: Truncgil'in aynı değer döndürdüğü Reşat/Hamit/Ata için HTML scraping
const CANLIDOVIZ_BASE = 'https://canlidoviz.com/altin-fiyatlari';
const SIKKE_SLUGS = [
    { slug: 'resat-lira-altin', key: 'resat-altin' },
    { slug: 'hamit-altin',      key: 'hamit-altin' },
    { slug: 'ata-altin',        key: 'ata-altin'   },
];

// Yahoo Finance futures: GenelPara tüm sunucu IP'lerini bloke ediyor (403)
const EMTIA_MAP = [
    { yahoo: 'SI=F',  key: 'XAGUSD',  name: 'Gümüş',           code: 'XAG'    },
    { yahoo: 'PL=F',  key: 'XPTUSD',  name: 'Platin',           code: 'XPT'    },
    { yahoo: 'PA=F',  key: 'XPDUSD',  name: 'Paladyum',         code: 'XPD'    },
    { yahoo: 'BZ=F',  key: 'XBRUSD',  name: 'Brent Ham Petrol', code: 'BRENT'  },
    { yahoo: 'CL=F',  key: 'COIL',    name: 'Ham Petrol (WTI)', code: 'WTI'    },
    { yahoo: 'HG=F',  key: 'COPPER',  name: 'Bakır',            code: 'COPPER' },
    { yahoo: 'NG=F',  key: 'NGAS',    name: 'Doğal Gaz',        code: 'NGAS'   },
    { yahoo: 'ZW=F',  key: 'WHEAT',   name: 'Buğday',           code: 'WHEAT'  },
    { yahoo: 'ZC=F',  key: 'CORN',    name: 'Mısır',            code: 'CORN'   },
    { yahoo: 'KC=F',  key: 'COFFEE',  name: 'Kahve',            code: 'COFFEE' },
    { yahoo: 'SB=F',  key: 'SUGAR',   name: 'Şeker',            code: 'SUGAR'  },
    { yahoo: 'CC=F',  key: 'COCOA',   name: 'Kakao',            code: 'COCOA'  },
    { yahoo: 'ZS=F',  key: 'SOYBEAN', name: 'Soya Fasulyesi',   code: 'SOYBEAN'},
    { yahoo: 'CT=F',  key: 'COTTON',  name: 'Pamuk',            code: 'COTTON' },
];

function coinGeckoUrl(ids) {
    return `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`;
}

// ── Yardımcı fonksiyonlar ─────────────────────────────────────────────────────

// curl tabanlı fetch: Türk finansal API'leri Node'un https modülünü
// datacenter IP olarak tanıyıp bloke ediyor; curl'ün TLS parmak izi bunu aşar.
async function fetchWithCurl(url, referer = '') {
    const args = [
        '-s', '--max-time', '15', '--compressed', '-L',
        '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        '-H', 'Accept: application/json, text/javascript, */*; q=0.01',
        '-H', 'Accept-Language: tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        '-H', 'Connection: keep-alive',
        '-H', 'Cache-Control: no-cache',
    ];
    if (referer) args.push('-H', `Referer: ${referer}`);
    args.push(url);
    try {
        const r = spawnSync('curl', args, { timeout: 20000, maxBuffer: 5 * 1024 * 1024 });
        if (r.status !== 0 || !r.stdout) return null;
        const raw = r.stdout.toString('utf8');
        if (!raw || raw.trimStart().startsWith('<')) return null;
        return JSON.parse(raw);
    } catch { return null; }
}

// canlidoviz.com sikke sayfası scraper: fiyatlar server-rendered HTML içinde
async function fetchSikkeFiyati(slug) {
    const url  = `${CANLIDOVIZ_BASE}/${slug}`;
    const args = [
        '-s', '--max-time', '15', '-L',
        '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        '-H', 'Accept-Language: tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        '-H', 'Referer: https://canlidoviz.com/',
        url,
    ];
    try {
        const r = spawnSync('curl', args, { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
        if (r.status !== 0 || !r.stdout) return null;
        const html = r.stdout.toString('utf8');
        if (!html || html.length < 500) return null;
        // itemprop="price" → satış (ana ekran); dt="bA" → BAYİ ALIŞ
        const satisM = html.match(/itemprop="price"[^>]*>\s*([\d]{5,6}\.[\d]{1,4})/);
        const alisM  = html.match(/dt="bA"[^>]*>\s*([\d]{5,6}\.[\d]{1,4})/);
        const satis  = satisM ? parseFloat(satisM[1]) : NaN;
        const alis   = alisM  ? parseFloat(alisM[1])  : NaN;
        if (isNaN(satis) || satis <= 0) return null;
        return { alis: isNaN(alis) || alis <= 0 ? parseFloat((satis * 0.986).toFixed(4)) : alis, satis };
    } catch { return null; }
}

// Yahoo Finance ve CoinGecko için: bu API'ler Node https modülünü kabul ediyor
function fetchJson(url) {
    return new Promise(resolve => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/json,*/*'
            }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchJson(res.headers.location).then(resolve);
            }
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try {
                    if (raw.trimStart().startsWith('<')) { resolve(null); return; }
                    resolve(JSON.parse(raw));
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    });
}

function parseTR(val) {
    if (val == null) return NaN;
    const s = String(val).replace(/[\s$€£¥TL]/gi, '').trim();
    if (!s || s === '-') return NaN;
    if (s.includes(',') && s.includes('.')) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
    if (s.includes(',')) return parseFloat(s.replace(',', '.'));
    return parseFloat(s);
}

// ── History cache yardımcıları ───────────────────────────────────────────────

function sanitizeYahoo(symbol) {
    return symbol.replace(/=/g, '_').replace(/\./g, '_');
}

function historyFilePath(symbol, rangeName) {
    return path.join(HISTORY_DIR, `${sanitizeYahoo(symbol)}-${rangeName}.json`);
}

function isHistoryStale(symbol, rangeName, maxAgeMs) {
    try {
        const stats = fs.statSync(historyFilePath(symbol, rangeName));
        return (Date.now() - stats.mtimeMs) > maxAgeMs;
    } catch {
        return true; // dosya yok
    }
}

async function fetchAndSaveHistory(symbol, rangeName, interval, range) {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    const data = await fetchJson(url);
    if (!data) return false;
    try {
        const result = data.chart.result[0];
        const quote  = result.indicators.quote[0];
        const closes = (quote.close || []).filter(v => v != null && !isNaN(v) && v > 0);
        if (closes.length === 0) return false;
        const highs  = (quote.high  || []).filter(v => v != null && !isNaN(v) && v > 0);
        const lows   = (quote.low   || []).filter(v => v != null && !isNaN(v) && v > 0);
        const opens  = (quote.open  || []).filter(v => v != null && !isNaN(v) && v > 0);
        const histData = {
            points:    closes,
            open:      opens[0]   ?? closes[0],
            high:      highs.length > 0 ? Math.max(...highs)  : Math.max(...closes),
            low:       lows.length  > 0 ? Math.min(...lows)   : Math.min(...closes),
            close:     closes[closes.length - 1],
            updatedAt: new Date().toISOString(),
        };
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
        fs.writeFileSync(historyFilePath(symbol, rangeName), JSON.stringify(histData), 'utf8');
        return true;
    } catch {
        return false;
    }
}

// ── Altın key → meta tablosu ──────────────────────────────────────────────────
const GOLD_MAP = {
    'gram-altin':       { name: 'Gram Altın',          code: 'GRAM',    type: 'gold' },
    'ons':              { name: 'Ons Altın',            code: 'ONS',     type: 'gold', isUSD: true },
    'ceyrek-altin':     { name: 'Çeyrek Altın',         code: 'CEYREK',  type: 'gold' },
    'yarim-altin':      { name: 'Yarım Altın',          code: 'YARIM',   type: 'gold' },
    'tam-altin':        { name: 'Tam Altın',            code: 'TAM',     type: 'gold' },
    'cumhuriyet-altini':{ name: 'Cumhuriyet Altını',    code: 'CUMHUR',  type: 'gold' },
    'ata-altin':        { name: 'Ata Altın',            code: 'ATAALT',  type: 'gold' },
    'resat-altin':      { name: 'Reşat Altın',          code: 'RESAT',   type: 'gold' },
    'hamit-altin':      { name: 'Hamit Altın',          code: 'HAMIT',   type: 'gold' },
    'gram-has-altin':   { name: 'Gram Has Altın',       code: 'HAS',     type: 'gold' },
    '14-ayar-altin':    { name: '14 Ayar Altın',        code: '14AYAR',  type: 'gold' },
    '18-ayar-altin':    { name: '18 Ayar Altın',        code: '18AYAR',  type: 'gold' },
    '22-ayar-bilezik':  { name: '22 Ayar Bilezik',      code: '22AYAR',  type: 'gold' },
    'gumus':            { name: 'Gümüş',                code: 'GUMUS',   type: 'commodity' },
    'gram-platin':      { name: 'Gram Platin',           code: 'PLATIN',  type: 'commodity' },
};

const CURRENCY_NAMES = {
    USD: 'ABD Doları',      EUR: 'Euro',               GBP: 'İngiliz Sterlini',
    JPY: 'Japon Yeni',      CHF: 'İsviçre Frangı',     CAD: 'Kanada Doları',
    AUD: 'Avustralya Doları', NZD: 'Yeni Zelanda Doları', SEK: 'İsveç Kronası',
    NOK: 'Norveç Kronası',  DKK: 'Danimarka Kronası',  SAR: 'Suudi Riyali',
    RUB: 'Rus Rublesi',     CNY: 'Çin Yuanı',          HKD: 'Hong Kong Doları',
    SGD: 'Singapur Doları', INR: 'Hindistan Rupisi',   KWD: 'Kuveyt Dinarı',
    AED: 'BAE Dirhemi',     ZAR: 'Güney Afrika Randı', BRL: 'Brezilya Reali',
    MXN: 'Meksika Pesosu',  ILS: 'İsrail Şekeli',      PLN: 'Polonya Zlotısı',
    CZK: 'Çek Korunası',    HUF: 'Macar Forinti',      RON: 'Rumen Leyi',
    AZN: 'Azerbaycan Manatı', QAR: 'Katar Riyali',
};

// Truncgil'den gelen ama desteklenmeyen dövizler (history kaynağı yok)
const CURRENCY_BLACKLIST = new Set(['BAM', 'GEL', 'SYP']);

// ── BIST hisse tablosu (Yahoo Finance .IS) ────────────────────────────────────
const BIST_STOCKS = [
    { yahoo: 'GARAN.IS',  key: 'garan',  name: 'Garanti BBVA',        code: 'GARAN'  },
    { yahoo: 'AKBNK.IS',  key: 'akbnk',  name: 'Akbank',              code: 'AKBNK'  },
    { yahoo: 'YKBNK.IS',  key: 'ykbnk',  name: 'Yapı Kredi',          code: 'YKBNK'  },
    { yahoo: 'ISCTR.IS',  key: 'isctr',  name: 'İş Bankası (C)',      code: 'ISCTR'  },
    { yahoo: 'HALKB.IS',  key: 'halkb',  name: 'Halkbank',            code: 'HALKB'  },
    { yahoo: 'VAKBN.IS',  key: 'vakbn',  name: 'Vakıfbank',           code: 'VAKBN'  },
    { yahoo: 'THYAO.IS',  key: 'thyao',  name: 'Türk Hava Yolları',   code: 'THYAO'  },
    { yahoo: 'ASELS.IS',  key: 'asels',  name: 'Aselsan',             code: 'ASELS'  },
    { yahoo: 'EREGL.IS',  key: 'eregl',  name: 'Ereğli Demir Çelik', code: 'EREGL'  },
    { yahoo: 'SISE.IS',   key: 'sise',   name: 'Şişecam',             code: 'SISE'   },
    { yahoo: 'KCHOL.IS',  key: 'kchol',  name: 'Koç Holding',         code: 'KCHOL'  },
    { yahoo: 'SAHOL.IS',  key: 'sahol',  name: 'Sabancı Holding',     code: 'SAHOL'  },
    { yahoo: 'TUPRS.IS',  key: 'tuprs',  name: 'Tüpraş',              code: 'TUPRS'  },
    { yahoo: 'TOASO.IS',  key: 'toaso',  name: 'Tofaş',               code: 'TOASO'  },
    { yahoo: 'FROTO.IS',  key: 'froto',  name: 'Ford Otosan',         code: 'FROTO'  },
    { yahoo: 'OTKAR.IS',  key: 'otkar',  name: 'Otokar',              code: 'OTKAR'  },
    { yahoo: 'TCELL.IS',  key: 'tcell',  name: 'Turkcell',            code: 'TCELL'  },
    { yahoo: 'TTKOM.IS',  key: 'ttkom',  name: 'Türk Telekom',        code: 'TTKOM'  },
    { yahoo: 'LOGO.IS',   key: 'logo',   name: 'Logo Yazılım',        code: 'LOGO'   },
    { yahoo: 'ENKAI.IS',  key: 'enkai',  name: 'Enka İnşaat',         code: 'ENKAI'  },
    { yahoo: 'BIMAS.IS',  key: 'bimas',  name: 'BİM Mağazalar',       code: 'BIMAS'  },
    { yahoo: 'MGROS.IS',  key: 'mgros',  name: 'Migros',              code: 'MGROS'  },
    { yahoo: 'PGSUS.IS',  key: 'pgsus',  name: 'Pegasus',             code: 'PGSUS'  },
    { yahoo: 'ULKER.IS',  key: 'ulker',  name: 'Ülker',               code: 'ULKER'  },
];

// ── CoinGecko kripto tablosu ──────────────────────────────────────────────────
// CoinGecko: API key gerektirmez, 30 istek/dk, GH Actions'dan kesinlikle çalışır
const COINGECKO_CRYPTO = [
    { gecko: 'bitcoin',          key: 'btc',   name: 'Bitcoin',        code: 'BTC'   },
    { gecko: 'ethereum',         key: 'eth',   name: 'Ethereum',       code: 'ETH'   },
    { gecko: 'binancecoin',      key: 'bnb',   name: 'BNB',            code: 'BNB'   },
    { gecko: 'solana',           key: 'sol',   name: 'Solana',         code: 'SOL'   },
    { gecko: 'ripple',           key: 'xrp',   name: 'XRP',            code: 'XRP'   },
    { gecko: 'dogecoin',         key: 'doge',  name: 'Dogecoin',       code: 'DOGE'  },
    { gecko: 'litecoin',         key: 'ltc',   name: 'Litecoin',       code: 'LTC'   },
    { gecko: 'cardano',          key: 'ada',   name: 'Cardano',        code: 'ADA'   },
    { gecko: 'avalanche-2',      key: 'avax',  name: 'Avalanche',      code: 'AVAX'  },
    { gecko: 'polkadot',         key: 'dot',   name: 'Polkadot',       code: 'DOT'   },
    { gecko: 'chainlink',        key: 'link',  name: 'Chainlink',      code: 'LINK'  },
    { gecko: 'cosmos',           key: 'atom',  name: 'Cosmos',         code: 'ATOM'  },
    { gecko: 'tron',             key: 'trx',   name: 'TRON',           code: 'TRX'   },
    { gecko: 'matic-network',    key: 'matic', name: 'Polygon',        code: 'MATIC' },
    { gecko: 'shiba-inu',        key: 'shib',  name: 'Shiba Inu',      code: 'SHIB'  },
    { gecko: 'near',             key: 'near',  name: 'NEAR Protocol',  code: 'NEAR'  },
    { gecko: 'uniswap',          key: 'uni',   name: 'Uniswap',        code: 'UNI'   },
    { gecko: 'arbitrum',         key: 'arb',   name: 'Arbitrum',       code: 'ARB'   },
    { gecko: 'the-open-network', key: 'ton',   name: 'Toncoin',        code: 'TON'   },
    { gecko: 'sui',              key: 'sui',   name: 'Sui',            code: 'SUI'   },
];

// ── History için Yahoo sembol listeleri ──────────────────────────────────────
const FOREX_YAHOO_SYMBOLS = [
    'USDTRY=X','EURTRY=X','GBPTRY=X','JPYTRY=X','CHFTRY=X','CADTRY=X',
    'AUDTRY=X','NZDTRY=X','SEKTRY=X','NOKTRY=X','DKKTRY=X','RUBTRY=X',
    'CNYTRY=X','HKDTRY=X','SGDTRY=X','INRTRY=X','SARTRY=X','AEDTRY=X',
    'KWDTRY=X','ZARTRY=X','BRLTRY=X','MXNTRY=X','ILSTRY=X','PLNTRY=X',
    'CZKTRY=X','HUFTRY=X','RONTRY=X','AZNTRY=X','QARTRY=X',
];

const CRYPTO_YAHOO_SYMBOLS = [
    'BTC-USD','ETH-USD','BNB-USD','SOL-USD','XRP-USD','DOGE-USD',
    'LTC-USD','ADA-USD','AVAX-USD','DOT-USD','LINK-USD','ATOM-USD',
    'TRX-USD','MATIC-USD','SHIB-USD','NEAR-USD','UNI7083-USD',
    'ARB11841-USD','TON11419-USD','SUI20947-USD',
];

// ── Ana fonksiyon ─────────────────────────────────────────────────────────────
async function run() {
    let current = {};
    try { current = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch {}

    // Istanbul günlük açılış takibi (UTC+3): her altın türü kendi değişimini hesaplar.
    // Yeni gün → açılış fiyatları sıfırlanır; aynı gün → depolanmış açılıştan hesap yapılır.
    const nowTR   = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const todayTR = nowTR.toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const dailyOpen = (current['_daily_open']?.date === todayTR)
        ? current['_daily_open']
        : { date: todayTR, prices: {} };

    // ── 1. Truncgil (Altın + Döviz) ──────────────────────────────────────────
    console.log('⬇️  Truncgil çekiliyor...');
    const tData = await fetchWithCurl(TRUNCGIL_URL, 'https://finans.truncgil.com/');
    let usdTry = current['USD']?.current || 38;

    if (tData) {
        if (tData['USD']) {
            const u = parseTR(tData['USD'].Selling);
            if (!isNaN(u) && u > 0) usdTry = u;
        }

        // Altın & Emtia (V3 API: Buying/Selling/Type/Change — İngilizce alan adları)
        Object.entries(GOLD_MAP).forEach(([tKey, meta]) => {
            const row = tData[tKey];
            if (!row) return;
            let satis = parseTR(row.Selling);
            let alis  = parseTR(row.Buying);
            const chg = parseTR(String(row.Change || '0').replace('%', ''));
            if (isNaN(satis) || satis <= 0) return;
            if (meta.isUSD) {
                satis = parseFloat((satis * usdTry).toFixed(2));
                if (!isNaN(alis) && alis > 0) alis = parseFloat((alis * usdTry).toFixed(2));
            }
            // İlk run'da (veya yeni günde) açılış fiyatı olarak kaydet
            if (!dailyOpen.prices[tKey]) dailyOpen.prices[tKey] = satis;
            const goldOpen    = dailyOpen.prices[tKey];
            const chgComputed = goldOpen > 0
                ? parseFloat(((satis - goldOpen) / goldOpen * 100).toFixed(2))
                : (!isNaN(chg) ? chg : 0);
            current[tKey] = {
                name: meta.name, code: meta.code, type: meta.type,
                current: satis, selling: satis,
                buying:  !isNaN(alis) && alis > 0 ? alis : parseFloat((satis * 0.995).toFixed(2)),
                change:  chgComputed,
                open:    goldOpen,
            };
        });

        // Döviz (V3 API: Type === 'Currency')
        Object.entries(tData).forEach(([sym, row]) => {
            if (!row || row.Type !== 'Currency') return;
            const satis  = parseTR(row.Selling);
            const alis   = parseTR(row.Buying);
            const chgStr = String(row.Change || '0').replace('%', '');
            const chg    = parseTR(chgStr);
            if (isNaN(satis) || satis <= 0) return;
            if (CURRENCY_BLACKLIST.has(sym)) return;
            current[sym] = {
                name: CURRENCY_NAMES[sym] || sym, code: sym, type: 'currency',
                current: satis, selling: satis,
                buying:  !isNaN(alis) && alis > 0 ? alis : parseFloat((satis * 0.995).toFixed(2)),
                change:  !isNaN(chg) ? chg : 0
            };
        });
        console.log(`  ✅ Truncgil: altın + döviz işlendi`);
    } else {
        console.warn('  ⚠️ Truncgil verisi alınamadı, mevcut fiyatlar korunuyor');
    }

    // ── 2. canlidoviz (Reşat/Hamit/Ata — diferansiye koleksiyoncu fiyatları) ───
    // Truncgil üçü için aynı değeri döndürür; canlidoviz gerçek prim farklarını
    // yansıtır. Server-rendered HTML, curl ile erişilebilir.
    console.log('⬇️  canlidoviz sikke fiyatları çekiliyor...');
    let sikkeCount = 0;
    for (const sikke of SIKKE_SLUGS) {
        const data = await fetchSikkeFiyati(sikke.slug);
        if (data) {
            const existing = current[sikke.key] || {};
            if (!dailyOpen.prices[sikke.key]) dailyOpen.prices[sikke.key] = data.satis;
            const sOpen = dailyOpen.prices[sikke.key];
            const sChg  = sOpen > 0
                ? parseFloat(((data.satis - sOpen) / sOpen * 100).toFixed(2))
                : (existing.change || 0);
            current[sikke.key] = {
                ...existing,
                current: data.satis,
                selling: data.satis,
                buying:  data.alis,
                open:    sOpen,
                change:  sChg,
            };
            sikkeCount++;
        }
    }
    console.log(`  ${sikkeCount > 0 ? '✅' : '⚠️'} canlidoviz: ${sikkeCount}/3 sikke işlendi`);

    // ── 3. Yahoo Finance (Emtia) ────────────────────────────────────────────────
    console.log('⬇️  Yahoo Finance emtia çekiliyor...');
    let emtiaCount = 0;
    for (const emtia of EMTIA_MAP) {
        const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(emtia.yahoo)}?interval=1d&range=2d`;
        const data = await fetchJson(url);
        try {
            const r    = data.chart.result[0];
            const meta = r.meta;
            let price  = meta.regularMarketPrice;
            const prev = meta.chartPreviousClose || meta.previousClose;
            if (!price || price <= 0) continue;
            // Tarım futures Yahoo'da USX (sent) döner — USD'ye çevir
            const isUSX = meta.currency === 'USX';
            if (isUSX) price = price / 100;
            const priceUSD = parseFloat(price.toFixed(4));
            const priceTRY = parseFloat((priceUSD * usdTry).toFixed(2));
            const prevUSD  = prev ? (isUSX ? prev / 100 : prev) : null;
            const chg      = prevUSD ? parseFloat(((price - prevUSD) / prevUSD * 100).toFixed(2)) : 0;
            current[emtia.key] = {
                name: emtia.name, code: emtia.code, type: 'commodity',
                current: priceTRY, selling: priceTRY,
                buying:  parseFloat((priceTRY * 0.998).toFixed(2)),
                change:  chg,
                priceUSD
            };
            emtiaCount++;
        } catch { /* veri yoksa atla */ }
        await new Promise(r => setTimeout(r, 200));
    }
    console.log(`  ${emtiaCount > 0 ? '✅' : '⚠️'} Yahoo Finance emtia: ${emtiaCount}/14 işlendi`);

    // ── 4. Yahoo Finance (BIST Hisse) ────────────────────────────────────────
    console.log('⬇️  Yahoo Finance BIST hisseler çekiliyor...');
    let stockCount = 0;
    for (const stock of BIST_STOCKS) {
        const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(stock.yahoo)}?interval=1d&range=2d`;
        const data = await fetchJson(url);
        try {
            const r      = data.chart.result[0];
            const meta   = r.meta;
            const price  = meta.regularMarketPrice;
            const prev   = meta.chartPreviousClose || meta.previousClose;
            if (!price || price <= 0) continue;
            const chg = prev ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0;
            current[stock.key] = {
                name: stock.name, code: stock.code, type: 'stock',
                current: parseFloat(price.toFixed(2)),
                selling: parseFloat(price.toFixed(2)),
                buying:  parseFloat(price.toFixed(2)),
                change:  chg
            };
            stockCount++;
        } catch { /* veri yoksa atla */ }
        await new Promise(r => setTimeout(r, 300));
    }
    console.log(`  ✅ Yahoo Finance: ${stockCount} hisse işlendi`);

    // ── 4. CoinGecko (Kripto) ────────────────────────────────────────────────
    console.log('⬇️  CoinGecko kripto çekiliyor...');
    const geckoIds = COINGECKO_CRYPTO.map(m => m.gecko);
    const cgData   = await fetchJson(coinGeckoUrl(geckoIds));
    let cryptoCount = 0;

    if (cgData && typeof cgData === 'object' && !cgData.status) {
        for (const meta of COINGECKO_CRYPTO) {
            const row = cgData[meta.gecko];
            if (!row) continue;
            const priceUSD = row['usd'];
            if (!priceUSD || priceUSD <= 0) continue;
            const chg      = parseFloat((row['usd_24h_change'] || 0).toFixed(2));
            const raw      = priceUSD * usdTry;
            // Çok küçük fiyatlar (SHIB gibi) için anlamlı basamak sayısı koru
            const decimals = raw >= 1 ? 2 : raw >= 0.01 ? 4 : raw >= 0.0001 ? 6 : 8;
            const priceTRY = parseFloat(raw.toFixed(decimals));
            current[meta.key] = {
                name: meta.name, code: meta.code, type: 'crypto',
                current: priceTRY, selling: priceTRY, buying: priceTRY,
                change: chg, priceUSD
            };
            cryptoCount++;
        }
        console.log(`  ✅ CoinGecko: ${cryptoCount} kripto işlendi`);
    } else {
        console.warn('  ⚠️ CoinGecko verisi alınamadı, bir önceki değerler korunuyor');
        if (cgData?.status) console.warn('  CoinGecko hata:', cgData.status.error_message);
    }

    // ── 5. History cache (GitHub Pages CDN) ──────────────────────────────────
    // Her varlığın GÜN/HAFTA/AY/YIL geçmişi data/history/{sembol}-{aralık}.json'a yazılır.
    // Android app önce buradan okur; Yahoo Finance sadece fallback olarak kullanılır.
    const ALL_YAHOO_SYMBOLS = [...new Set([
        'GC=F', 'SI=F', 'PL=F',                       // Altın / kıymetli maden
        ...EMTIA_MAP.map(e => e.yahoo),                 // Emtia
        ...BIST_STOCKS.map(s => s.yahoo),               // BIST hisseler
        ...FOREX_YAHOO_SYMBOLS,                          // Döviz (TRY bazlı)
        ...CRYPTO_YAHOO_SYMBOLS,                         // Kripto (Yahoo)
    ])];

    const HISTORY_RANGES = [
        { name: 'gun',   interval: '5m',  yahooRange: '1d'  },
        { name: 'hafta', interval: '1d',  yahooRange: '7d'  },
        { name: 'ay',    interval: '1d',  yahooRange: '1mo' },
        { name: 'yil',   interval: '1wk', yahooRange: '1y'  },
    ];

    console.log(`⬇️  History cache: ${ALL_YAHOO_SYMBOLS.length} sembol × 4 aralık güncelleniyor...`);
    let historyCount = 0, historySkipped = 0;
    for (const symbol of ALL_YAHOO_SYMBOLS) {
        for (const r of HISTORY_RANGES) {
            // GÜN: her zaman tazele (intraday); diğerleri: 6 saatten eskiyse tazele
            const maxAge = r.name === 'gun' ? 0 : SIX_HOURS_MS;
            if (!isHistoryStale(symbol, r.name, maxAge)) { historySkipped++; continue; }
            const ok = await fetchAndSaveHistory(symbol, r.name, r.interval, r.yahooRange);
            if (ok) historyCount++;
            await new Promise(res => setTimeout(res, 150));
        }
    }
    console.log(`  ✅ History cache: ${historyCount} dosya güncellendi, ${historySkipped} atlandı`);

    // ── Meta bilgisi ekle ve kaydet ───────────────────────────────────────────
    current['_daily_open'] = dailyOpen;
    current['_meta'] = {
        updated_at: new Date().toISOString(),
        source: 'Truncgil V3 (altın+döviz) | Yahoo Finance (emtia+hisse) | CoinGecko (kripto)'
    };

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    // Atomic write: önce .tmp yaz, sonra rename — yarım yazma corruption'ını önler
    const tmpFile = OUTPUT_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(current, null, 2), 'utf8');
    fs.renameSync(tmpFile, OUTPUT_FILE);
    console.log(`\n✅ data/current.json kaydedildi (${Object.keys(current).length - 1} varlık)`);
}

run().catch(err => {
    console.error('❌ Hata:', err);
    process.exit(1);
});
