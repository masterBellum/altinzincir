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

const OUTPUT_FILE  = path.join(__dirname, '..', 'data', 'current.json');
const HISTORY_DIR  = path.join(__dirname, '..', 'data', 'history');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.json');
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// ── Kaynak URL'leri ───────────────────────────────────────────────────────────
const TRUNCGIL_URL    = 'https://finans.truncgil.com/v3/today.json';
// canlidoviz.com: TÜM altın türleri için baz veri kaynağı.
// Truncgil V3 çeyrek/yarım/tam/14-18-22 ayar/sikkeler için stale placeholder
// (+0.02% her zaman aynı) döndürdüğü için canlidoviz'in dt="change" verisini
// kullanıyoruz. Tüm türler aynı kaynaktan = tutarlı change%.
const CANLIDOVIZ_BASE = 'https://canlidoviz.com/altin-fiyatlari';
const GOLD_SLUGS = [
    { slug: 'gram-altin',         key: 'gram-altin'        },
    { slug: 'ceyrek-altin',       key: 'ceyrek-altin'      },
    { slug: 'yarim-altin',        key: 'yarim-altin'       },
    { slug: 'tam-altin',          key: 'tam-altin'         },
    { slug: 'cumhuriyet-altini',  key: 'cumhuriyet-altini' },
    { slug: 'ata-altin',          key: 'ata-altin'         },
    { slug: 'resat-lira-altin',   key: 'resat-altin'       },
    { slug: 'hamit-altin',        key: 'hamit-altin'       },
    { slug: 'gram-has-altin',     key: 'gram-has-altin'    },
    { slug: '14-ayar-altin',      key: '14-ayar-altin'     },
    { slug: '18-ayar-altin',      key: '18-ayar-altin'     },
    { slug: '22-ayar-bilezik',    key: '22-ayar-bilezik'   },
    { slug: 'gumus',              key: 'gumus'             },
    // gram-platin: canlidoviz'de yok (redirect); ons: USD veriyor ama TRY etiketli (bug)
    // → bu ikisi Truncgil V3'ten çekilir (aşağıdaki Truncgil-only fallback bölümü)
];

// canlidoviz'de mevcut olmayan, sadece Truncgil V3'ten alınacak altın türleri
const TRUNCGIL_ONLY_GOLD_KEYS = ['gram-platin', 'ons'];

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
        // itemprop="price" → satış; dt="bA" → BAYİ ALIŞ.
        // dt="change" üst banner'da onlarca kez geçer (USD/EUR/GBP tickerları).
        // Sayfanın asıl varlığının değişimi `class="currency-change-text-lg"` hero
        // etiketinde. Yedek: itemprop=price'ın hemen yakınındaki `cp` (önceki kapanış)
        // ile current price farkını hesapla.
        const satisM = html.match(/itemprop="price"[^>]*>\s*([\d]+(?:\.\d+)?)/);
        const alisM  = html.match(/dt="bA"[^>]*>\s*([\d]+(?:\.\d+)?)/);
        // Hero badge: class="currency-change-text-lg" ... dt="change" ... > %X.YZ
        let chgM = html.match(/class="currency-change-text-lg"[^>]*dt="change"[^>]*>\s*%(-?\d+(?:\.\d+)?)/);
        // Alternatif sıra: dt="change" ... class="currency-change-text-lg"
        if (!chgM) chgM = html.match(/dt="change"[^>]*class="currency-change-text-lg"[^>]*>\s*%(-?\d+(?:\.\d+)?)/);
        // Son çare: hero `dt="amount"` etiketindeki cp (prev close) ile satış farkı
        let chgFromCp = null;
        const cpM = html.match(/itemprop="price"[\s\S]{0,300}cp="([\d.]+)"/);
        if (cpM && satisM) {
            const cp = parseFloat(cpM[1]);
            const px = parseFloat(satisM[1]);
            if (cp > 0 && px > 0) chgFromCp = parseFloat(((px - cp) / cp * 100).toFixed(2));
        }
        const satis  = satisM ? parseFloat(satisM[1]) : NaN;
        const alis   = alisM  ? parseFloat(alisM[1])  : NaN;
        const change = chgM   ? parseFloat(chgM[1])   : (chgFromCp != null ? chgFromCp : NaN);
        if (isNaN(satis) || satis <= 0) return null;
        return {
            alis: isNaN(alis) || alis <= 0 ? parseFloat((satis * 0.986).toFixed(4)) : alis,
            satis,
            change: isNaN(change) ? null : change,
        };
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

// TCMB resmi döviz kurları (today.xml) — Türk Merkez Bankası açık veri
async function fetchTcmbRates() {
    const args = [
        '-s', '--max-time', '15', '--compressed', '-L',
        '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'https://www.tcmb.gov.tr/kurlar/today.xml',
    ];
    let xml = '';
    try {
        const r = spawnSync('curl', args, { timeout: 20000, maxBuffer: 5 * 1024 * 1024 });
        if (r.status !== 0 || !r.stdout) return null;
        xml = r.stdout.toString('utf8');
        if (!xml || xml.length < 100) return null;
    } catch { return null; }
    const rates = {};
    const re = /<Currency[^>]*CurrencyCode="([A-Z]{3})"[^>]*>([\s\S]*?)<\/Currency>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const code  = m[1];
        const block = m[2];
        const unit  = parseFloat((block.match(/<Unit>([^<]+)<\/Unit>/) || [])[1] || '1');
        const sel   = parseFloat((block.match(/<ForexSelling>([^<]+)<\/ForexSelling>/) || [])[1] || '0');
        const buy   = parseFloat((block.match(/<ForexBuying>([^<]+)<\/ForexBuying>/) || [])[1] || '0');
        if (sel > 0 && unit > 0) {
            rates[code] = {
                selling: parseFloat((sel / unit).toFixed(4)),
                buying:  buy > 0 ? parseFloat((buy / unit).toFixed(4))
                                 : parseFloat((sel * 0.998 / unit).toFixed(4)),
            };
        }
    }
    return Object.keys(rates).length > 0 ? rates : null;
}

// fawazahmed0/currency-api (jsdelivr CDN) — CC0 lisans, 200+ para birimi
async function fetchFawazRate(currencyCode) {
    const base = currencyCode.toLowerCase();
    const url  = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base}.json`;
    const data = await fetchJson(url);
    if (!data || !data[base]) return null;
    const rate = data[base]['try'];
    return (rate && rate > 0) ? parseFloat(rate.toFixed(4)) : null;
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

// Gerçek piyasa history (build_history.js accumulator'ından):
// data/history.json içinde her varlık için hourly[]/daily[]/monthly[]/yearly[] var.
// Bunları per-asset {key}-{range}.json formatına çevirir. Sentetik'in üstüne yazılır
// (gerçek piyasa premium dalgalanması — ata/reşat/hamit gibi sikkeler için kritik).
function writeRealHistoryFromAccumulator(key, rangeName, hSeries) {
    if (!Array.isArray(hSeries) || hSeries.length < 2) return false;
    const points = hSeries
        .map(v => parseFloat(v))
        .filter(v => Number.isFinite(v) && v > 0);
    if (points.length < 2) return false;
    const histData = {
        points,
        open:  points[0],
        high:  Math.max(...points),
        low:   Math.min(...points),
        close: points[points.length - 1],
        updatedAt: new Date().toISOString(),
        source: 'accumulator',
    };
    try {
        fs.writeFileSync(historyFilePath(key, rangeName), JSON.stringify(histData), 'utf8');
        return true;
    } catch { return false; }
}

// Sentetik history: spot (USD/oz) × USDTRY ÷ 31.1035 → gram TRY,
// sonra "ratio = currentPrice / synthetic[last]" ile her key'e özel ölçeğe çek.
// Çıktı dosyası `data/history/{key}-{range}.json` (app key-first arama yapıyor).
function buildSyntheticHistory(key, sourceSymbol, rangeName, currentPriceTRY) {
    const TROY_OZ_GRAMS = 31.1034768;
    try {
        const spotPath = historyFilePath(sourceSymbol, rangeName);
        const fxPath   = historyFilePath('USDTRY=X',   rangeName);
        if (!fs.existsSync(spotPath) || !fs.existsSync(fxPath)) return false;
        const spot = JSON.parse(fs.readFileSync(spotPath, 'utf8'));
        const fx   = JSON.parse(fs.readFileSync(fxPath,   'utf8'));
        const sp = spot.points || [];
        const fp = fx.points   || [];
        if (sp.length < 2 || fp.length < 2) return false;
        // Sondan başa hizala (uzunluklar farklı olabilir — Yahoo aralık döndürmesi tutarsız)
        const n = Math.min(sp.length, fp.length);
        const sTail = sp.slice(-n);
        const fTail = fp.slice(-n);
        // gram TRY synthetic
        const synth = new Array(n);
        for (let i = 0; i < n; i++) synth[i] = (sTail[i] / TROY_OZ_GRAMS) * fTail[i];
        // Ratio: son nokta = mevcut TRY fiyat (kuyumcu premium'unu korur)
        const last = synth[n - 1];
        if (!last || last <= 0) return false;
        const ratio = currentPriceTRY / last;
        if (!isFinite(ratio) || ratio <= 0) return false;
        const points = synth.map(v => parseFloat((v * ratio).toFixed(4)));
        const histData = {
            points,
            open:  points[0],
            high:  Math.max(...points),
            low:   Math.min(...points),
            close: points[points.length - 1],
            updatedAt: new Date().toISOString(),
            synthetic: { source: sourceSymbol, ratio: parseFloat(ratio.toFixed(6)) },
        };
        fs.writeFileSync(historyFilePath(key, rangeName), JSON.stringify(histData), 'utf8');
        return true;
    } catch {
        return false;
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
        // En az 2 nokta yoksa dosyayı yazma — sparkline çizilemez, Android Yahoo fallback'a düşsün
        if (closes.length < 2) return false;
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
    { gecko: 'bitcoin',          yahoo: 'BTC-USD',       key: 'btc',   name: 'Bitcoin',        code: 'BTC'   },
    { gecko: 'ethereum',         yahoo: 'ETH-USD',       key: 'eth',   name: 'Ethereum',       code: 'ETH'   },
    { gecko: 'binancecoin',      yahoo: 'BNB-USD',       key: 'bnb',   name: 'BNB',            code: 'BNB'   },
    { gecko: 'solana',           yahoo: 'SOL-USD',       key: 'sol',   name: 'Solana',         code: 'SOL'   },
    { gecko: 'ripple',           yahoo: 'XRP-USD',       key: 'xrp',   name: 'XRP',            code: 'XRP'   },
    { gecko: 'dogecoin',         yahoo: 'DOGE-USD',      key: 'doge',  name: 'Dogecoin',       code: 'DOGE'  },
    { gecko: 'litecoin',         yahoo: 'LTC-USD',       key: 'ltc',   name: 'Litecoin',       code: 'LTC'   },
    { gecko: 'cardano',          yahoo: 'ADA-USD',       key: 'ada',   name: 'Cardano',        code: 'ADA'   },
    { gecko: 'avalanche-2',      yahoo: 'AVAX-USD',      key: 'avax',  name: 'Avalanche',      code: 'AVAX'  },
    { gecko: 'polkadot',         yahoo: 'DOT-USD',       key: 'dot',   name: 'Polkadot',       code: 'DOT'   },
    { gecko: 'chainlink',        yahoo: 'LINK-USD',      key: 'link',  name: 'Chainlink',      code: 'LINK'  },
    { gecko: 'cosmos',           yahoo: 'ATOM-USD',      key: 'atom',  name: 'Cosmos',         code: 'ATOM'  },
    { gecko: 'tron',             yahoo: 'TRX-USD',       key: 'trx',   name: 'TRON',           code: 'TRX'   },
    { gecko: 'matic-network',    yahoo: 'POL28321-USD',  key: 'matic', name: 'Polygon',        code: 'POL'   },
    { gecko: 'shiba-inu',        yahoo: 'SHIB-USD',      key: 'shib',  name: 'Shiba Inu',      code: 'SHIB'  },
    { gecko: 'near',             yahoo: 'NEAR-USD',      key: 'near',  name: 'NEAR Protocol',  code: 'NEAR'  },
    { gecko: 'uniswap',          yahoo: 'UNI7083-USD',   key: 'uni',   name: 'Uniswap',        code: 'UNI'   },
    { gecko: 'arbitrum',         yahoo: 'ARB11841-USD',  key: 'arb',   name: 'Arbitrum',       code: 'ARB'   },
    { gecko: 'the-open-network', yahoo: 'TON11419-USD',  key: 'ton',   name: 'Toncoin',        code: 'TON'   },
    { gecko: 'sui',              yahoo: 'SUI20947-USD',  key: 'sui',   name: 'Sui',            code: 'SUI'   },
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
    'TRX-USD','POL28321-USD','SHIB-USD','NEAR-USD','UNI7083-USD',
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
    // Bu run'da hangi dövizlerin yazıldığını izle — fallback'lar eski current.json
    // değerlerini değil sadece bu run'da yazılmayanları doldurur.
    const writtenCurrencies = new Set();

    if (tData) {
        if (tData['USD']) {
            const u = parseTR(tData['USD'].Selling);
            if (!isNaN(u) && u > 0) usdTry = u;
        }

        // Altın türlerinin çoğu canlidoviz'den çekilir (aşağıdaki bölüm).
        // Sadece canlidoviz'de bulunmayanlar (gram-platin, ons) Truncgil V3'ten:
        TRUNCGIL_ONLY_GOLD_KEYS.forEach(tKey => {
            const row = tData[tKey];
            const meta = GOLD_MAP[tKey];
            if (!row || !meta) return;
            let satis = parseTR(row.Selling);
            let alis  = parseTR(row.Buying);
            const chg = parseTR(String(row.Change || '0').replace('%', ''));
            if (isNaN(satis) || satis <= 0) return;
            if (meta.isUSD) {
                satis = parseFloat((satis * usdTry).toFixed(2));
                if (!isNaN(alis) && alis > 0) alis = parseFloat((alis * usdTry).toFixed(2));
            }
            const realChg = !isNaN(chg) ? chg : 0;
            const computedOpen = realChg !== -100
                ? parseFloat((satis / (1 + realChg / 100)).toFixed(2))
                : satis;
            current[tKey] = {
                name: meta.name, code: meta.code, type: meta.type,
                current: satis, selling: satis,
                buying:  !isNaN(alis) && alis > 0 ? alis : parseFloat((satis * 0.995).toFixed(2)),
                change:  realChg,
                open:    computedOpen,
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
            writtenCurrencies.add(sym);
        });
        console.log(`  ✅ Truncgil: altın + döviz işlendi (${writtenCurrencies.size} döviz)`);
    } else {
        console.warn('  ⚠️ Truncgil verisi alınamadı — TCMB/fawazahmed0 fallback denenecek');
    }

    // ── 1b. Döviz fallback: TCMB → fawazahmed0 ───────────────────────────────
    // Truncgil tamamen fail olduysa veya bazı dövizleri atladıysa boşlukları doldur.
    // CURRENCY_NAMES'deki tüm major dövizleri hedefle.
    const targetCurrencies = Object.keys(CURRENCY_NAMES).filter(c => !CURRENCY_BLACKLIST.has(c));
    const missingAfterTruncgil = targetCurrencies.filter(c => !writtenCurrencies.has(c));

    if (missingAfterTruncgil.length > 0) {
        console.log(`⬇️  TCMB döviz fallback (${missingAfterTruncgil.length} eksik döviz)...`);
        const tcmb = await fetchTcmbRates();
        let tcmbCount = 0;
        if (tcmb) {
            for (const sym of missingAfterTruncgil) {
                const r = tcmb[sym];
                if (!r) continue;
                // USD/TRY Truncgil'den gelemediyse usdTry değişkenini de güncelle (emtia/kripto için kritik)
                if (sym === 'USD') usdTry = r.selling;
                current[sym] = {
                    name: CURRENCY_NAMES[sym] || sym, code: sym, type: 'currency',
                    current: r.selling, selling: r.selling, buying: r.buying,
                    // TCMB günlük resmi referans veriyor; change için intraday yok → 0
                    change: 0,
                };
                writtenCurrencies.add(sym);
                tcmbCount++;
            }
            console.log(`  ${tcmbCount > 0 ? '✅' : '⚠️'} TCMB: ${tcmbCount} döviz eklendi`);
        } else {
            console.warn('  ⚠️ TCMB verisi alınamadı');
        }
    }

    const missingAfterTcmb = targetCurrencies.filter(c => !writtenCurrencies.has(c));
    if (missingAfterTcmb.length > 0) {
        console.log(`⬇️  fawazahmed0 fallback (${missingAfterTcmb.length} eksik döviz)...`);
        let fawazCount = 0;
        for (const sym of missingAfterTcmb) {
            const rate = await fetchFawazRate(sym);
            if (!rate) continue;
            if (sym === 'USD' && rate > 0) usdTry = rate;
            current[sym] = {
                name: CURRENCY_NAMES[sym] || sym, code: sym, type: 'currency',
                current: rate, selling: rate,
                buying:  parseFloat((rate * 0.998).toFixed(4)),
                change:  0,
            };
            writtenCurrencies.add(sym);
            fawazCount++;
            await new Promise(r => setTimeout(r, 150));
        }
        console.log(`  ${fawazCount > 0 ? '✅' : '⚠️'} fawazahmed0: ${fawazCount} döviz eklendi`);
    }

    // ── 2. canlidoviz (TÜM altın türleri — tek baz kaynak) ──────────────────
    // canlidoviz dt="change" attribute'u her altın türü için gerçek günlük
    // değişimi verir. Truncgil V3 türevler için stale +0.02% placeholder
    // döndürdüğünden tutarsız UI ortaya çıkıyordu (gram düşerken çeyrek sabit).
    // canlidoviz tek kaynak → gram düşerken çeyrek/yarım/tam da yakın yüzdede düşer.
    console.log('⬇️  canlidoviz altın fiyatları çekiliyor...');
    let goldCount = 0;
    for (const item of GOLD_SLUGS) {
        const data = await fetchSikkeFiyati(item.slug);
        if (!data) continue;
        const meta = GOLD_MAP[item.key] || { name: item.key, code: item.key.toUpperCase(), type: 'gold' };
        const realChg = data.change !== null ? data.change : 0;
        const computedOpen = realChg !== -100
            ? parseFloat((data.satis / (1 + realChg / 100)).toFixed(2))
            : data.satis;
        current[item.key] = {
            name: meta.name, code: meta.code, type: meta.type,
            current: data.satis,
            selling: data.satis,
            buying:  data.alis,
            change:  realChg,
            open:    computedOpen,
        };
        goldCount++;
        await new Promise(r => setTimeout(r, 100));
    }
    console.log(`  ${goldCount > 0 ? '✅' : '⚠️'} canlidoviz: ${goldCount}/${GOLD_SLUGS.length} altın işlendi`);

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

    // ── 4. CoinGecko (Kripto) — Yahoo Finance fallback'lı ───────────────────
    console.log('⬇️  CoinGecko kripto çekiliyor...');
    const geckoIds = COINGECKO_CRYPTO.map(m => m.gecko);
    const cgData   = await fetchJson(coinGeckoUrl(geckoIds));
    let cryptoCount = 0;

    // Ortak yazma yardımcısı — TRY hesaplama ve precision tek yerden
    const writeCrypto = (meta, priceUSD, chg) => {
        if (!priceUSD || priceUSD <= 0) return false;
        const raw      = priceUSD * usdTry;
        // Çok küçük fiyatlar (SHIB gibi) için anlamlı basamak sayısı koru
        const decimals = raw >= 1 ? 2 : raw >= 0.01 ? 4 : raw >= 0.0001 ? 6 : 8;
        const priceTRY = parseFloat(raw.toFixed(decimals));
        current[meta.key] = {
            name: meta.name, code: meta.code, type: 'crypto',
            current: priceTRY, selling: priceTRY, buying: priceTRY,
            change: chg, priceUSD: parseFloat(priceUSD.toFixed(8))
        };
        return true;
    };

    const geckoOk = cgData && typeof cgData === 'object' && !cgData.status;
    const geckoKeysWritten = new Set();
    if (geckoOk) {
        for (const meta of COINGECKO_CRYPTO) {
            const row = cgData[meta.gecko];
            if (!row) continue;
            const chg = parseFloat((row['usd_24h_change'] || 0).toFixed(2));
            if (writeCrypto(meta, row['usd'], chg)) {
                cryptoCount++;
                geckoKeysWritten.add(meta.key);
            }
        }
        console.log(`  ✅ CoinGecko: ${cryptoCount} kripto işlendi`);
    } else {
        console.warn('  ⚠️ CoinGecko verisi alınamadı — Yahoo Finance fallback deneniyor');
        if (cgData?.status) console.warn('  CoinGecko hata:', cgData.status.error_message);
    }

    // Yahoo Finance fallback: CoinGecko fail olduysa tüm coinler, kısmi başarı varsa
    // CoinGecko'nun atladığı coinler. Bu run'da CoinGecko'nun YAZDIĞI key'leri atla
    // (eski current.json değerlerini değil).
    let yahooCryptoCount = 0;
    for (const meta of COINGECKO_CRYPTO) {
        if (geckoKeysWritten.has(meta.key)) continue;
        if (!meta.yahoo) continue;
        const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(meta.yahoo)}?interval=1d&range=2d`;
        const data = await fetchJson(url);
        try {
            const r        = data.chart.result[0];
            const m        = r.meta;
            const priceUSD = m.regularMarketPrice;
            const prev     = m.chartPreviousClose || m.previousClose;
            const chg = (prev && priceUSD)
                ? parseFloat(((priceUSD - prev) / prev * 100).toFixed(2))
                : 0;
            if (writeCrypto(meta, priceUSD, chg)) yahooCryptoCount++;
        } catch { /* veri yoksa atla */ }
        await new Promise(res => setTimeout(res, 200));
    }
    if (yahooCryptoCount > 0) {
        console.log(`  ✅ Yahoo Finance fallback: ${yahooCryptoCount} kripto eklendi`);
    } else if (!geckoOk) {
        console.warn('  ⚠️ Yahoo Finance fallback da başarısız — eski değerler korunuyor');
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

    // ── 6. Sentetik history (Türkiye altın/gümüş/platin gram TRY) ────────────
    // gram-altin/çeyrek/yarım/.../gümüş/gram-platin için public history endpoint yok.
    // Yahoo spot (USD/oz) × USDTRY ÷ 31.1035 = gram TRY, sonra current.json'daki
    // fiyat ile ratio'la (kuyumcu premium'u korunsun, son nokta = canlı fiyat).
    const SYNTHETIC_GOLD_SOURCES = {
        // Altın türleri — kaynak GC=F (gold futures USD/oz)
        'gram-altin':        'GC=F',
        'ceyrek-altin':      'GC=F',
        'yarim-altin':       'GC=F',
        'tam-altin':         'GC=F',
        'cumhuriyet-altini': 'GC=F',
        'ata-altin':         'GC=F',
        'resat-altin':       'GC=F',
        'hamit-altin':       'GC=F',
        'gram-has-altin':    'GC=F',
        '14-ayar-altin':     'GC=F',
        '18-ayar-altin':     'GC=F',
        '22-ayar-bilezik':   'GC=F',
        'ons':               'GC=F',
        // Gümüş & platin — kaynak SI=F, PL=F
        'gumus':             'SI=F',
        'gram-platin':       'PL=F',
    };
    let synthCount = 0, synthSkipped = 0;
    for (const [key, sourceSymbol] of Object.entries(SYNTHETIC_GOLD_SOURCES)) {
        const row = current[key];
        if (!row) { synthSkipped++; continue; }
        const px = row.selling || row.current;
        if (!px || px <= 0) { synthSkipped++; continue; }
        for (const r of HISTORY_RANGES) {
            if (buildSyntheticHistory(key, sourceSymbol, r.name, px)) synthCount++;
        }
    }
    console.log(`  ✅ Sentetik history: ${synthCount} dosya yazıldı (${synthSkipped} atlandı)`);

    // ── 7. Gerçek piyasa history overlay (accumulator'dan) ───────────────────
    // data/history.json'da build_history.js'in 3+ yıldır biriktirdiği gerçek
    // piyasa kapanışları var (ata/reşat/hamit gibi sikkelerin kendi premium'lu
    // değerleri). Sentetik dosyaların üstüne yazıp gerçek seriyi sun.
    let realHistoryWritten = 0;
    try {
        const accumulator = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        // TÜM varlıklar için overlay — sadece altın değil; ata/reşat ekstra önemli.
        for (const [key, h] of Object.entries(accumulator)) {
            if (key.startsWith('_') || !h || typeof h !== 'object') continue;
            // gun: hourly (24'e kadar)  — en azından 2 nokta varsa
            if (h.hourly  && h.hourly.length  >= 2 && writeRealHistoryFromAccumulator(key, 'gun',   h.hourly))  realHistoryWritten++;
            // hafta: daily son 7-8 gün
            if (h.daily   && h.daily.length   >= 2 && writeRealHistoryFromAccumulator(key, 'hafta', h.daily.slice(-8)))   realHistoryWritten++;
            // ay: daily son 30 gün
            if (h.daily   && h.daily.length   >= 2 && writeRealHistoryFromAccumulator(key, 'ay',    h.daily.slice(-31)))  realHistoryWritten++;
            // yil: monthly son 12 ay (yoksa daily son 365 günden örnekle)
            const yearlySeries = (h.monthly && h.monthly.length >= 2)
                ? h.monthly.slice(-12)
                : (h.daily && h.daily.length > 30 ? h.daily.filter((_, i, a) => i % 7 === 0 || i === a.length - 1).slice(-60) : null);
            if (yearlySeries && writeRealHistoryFromAccumulator(key, 'yil', yearlySeries)) realHistoryWritten++;
        }
        console.log(`  ✅ Gerçek piyasa history overlay: ${realHistoryWritten} dosya yazıldı`);
    } catch (e) {
        console.warn(`  ⚠️ data/history.json okunamadı (${e.message}) — sadece sentetik kullanılacak`);
    }

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
