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

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * KAPSAM KARARI — 2026-08 (neden bazı veriler artık burada YOK)
 * ─────────────────────────────────────────────────────────────────────────────
 * Bu script'in ürettiği data/current.json GitHub Pages üzerinden HERKESE AÇIK
 * bir adreste yayınlanıyor. Yani veriyi sadece kullanmıyor, YENİDEN DAĞITIYORUZ.
 *
 * Yeniden dağıtım, incelenen ticari sağlayıcıların tamamının kullanım
 * şartlarında açıkça yasak: Yahoo Finance (resmî olmayan endpoint, "kişisel
 * kullanım"), Twelve Data, Finnhub, EODHD, Financial Modeling Prep ve Borsa
 * İstanbul'un kendi veri sözleşmesi. Bu yüzden şunlar KALDIRILDI:
 *
 *   • 97 BIST hissesi  → uygulamada TradingView gömülü widget'ına taşındı.
 *                        Widget'ta veri bizim tarafımızda hiç saklanmaz;
 *                        TradingView kendi lisansıyla doğrudan gösterir.
 *   • 14 Yahoo emtiası → uygulamadaki Emtia sekmesi tamamen kaldırıldı
 *                        (petrol, buğday, bakır, kahve, pamuk...).
 *
 * KORUNANLAR ve neden korunabildikleri:
 *   • Altın (canlidoviz + Truncgil) — robots.txt izin veriyor, halka açık API
 *   • Döviz (Truncgil → TCMB → fawazahmed0) — TCMB resmî kamu verisi,
 *     Frankfurter/fawazahmed0 açıkça serbest
 *   • Kripto (CoinGecko) — ücretsiz katman atıf şartıyla uygun; uygulamanın
 *     Ayarlar > Veri Kaynakları ekranında atıf veriliyor
 *   • gumus / gram-platin — Türk kuyumcu piyasasından, gram cinsinden.
 *     Uygulamada artık Altın sekmesinde gösteriliyorlar.
 *
 * TEK İSTİSNA: PL=F (platin futures) hâlâ Yahoo'dan çekiliyor — AMA dosyaya
 * YAZILMIYOR. Yalnızca gram-platin'in yüzde değişimini hesaplamakta
 * kullanılıyor, çünkü Truncgil'in Change alanı hafta sonu/tatilde bayat
 * kalıyor. Veri yayınlanmadığı için yeniden dağıtım söz konusu değil.
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

// ── Alış/satış makası (spread) ────────────────────────────────────────────────
// Bazı kaynaklar yalnızca tek fiyat veriyor (Yahoo futures, fawazahmed0, CoinGecko)
// ya da alış alanı boş geliyor. Bu durumda alış fiyatı satıştan tahmin edilir.
// Değerler piyasa gözlemine dayalı YAKLAŞIKTIR, kaynaktan gelen gerçek alış
// fiyatı varsa DAİMA o kullanılır — bu çarpanlar yalnızca son çare.
//   %0.2 → likit, dar makaslı enstrümanlar (döviz, emtia futures)
//   %0.5 → kuyumcu/serbest piyasa kalemleri (daha geniş makas)
const SPREAD_TIGHT = 0.998; // %0.2
const SPREAD_WIDE  = 0.995; // %0.5

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
    { slug: 'gremse-altin',       key: 'gremse-altin'      },
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
                                 : parseFloat((sel * SPREAD_TIGHT / unit).toFixed(4)),
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
/**
 * @param tsSeries Opsiyonel: hSeries ile ayni uzunlukta epoch-saniye dizisi.
 *   Neden onemli: points yalnizca sayi dizisiydi, zaman bilgisi tasimiyordu.
 *   Uygulama bu yuzden noktalari "araligin tamamina esit dagilmis" varsayip
 *   grafik tooltip'inde YANLIS saat gosteriyordu. Ornek: hourly serisi 06:00
 *   UTC'de sifirlanip saatlik birikiyor; oglen 9 nokta varken uygulama ilk
 *   noktayi "24 saat once" sanıyordu — 15 saate varan hata. Ustelik cron
 *   gecikmeleri yuzunden noktalar zaten esit arali degil.
 *   times yazildiginda uygulama gercek zamani kullanir.
 */
function writeRealHistoryFromAccumulator(key, rangeName, hSeries, tsSeries) {
    if (!Array.isArray(hSeries) || hSeries.length < 2) return false;
    // Fiyat ve zaman damgasini BIRLIKTE filtrele ki hizalama bozulmasin
    const pairs = hSeries
        .map((v, i) => ({ v: parseFloat(v), t: Array.isArray(tsSeries) ? tsSeries[i] : undefined }))
        .filter(p => Number.isFinite(p.v) && p.v > 0);
    if (pairs.length < 2) return false;
    const points = pairs.map(p => p.v);
    const times  = pairs.every(p => Number.isFinite(p.t)) ? pairs.map(p => p.t) : null;
    const histData = {
        points,
        ...(times ? { times } : {}),
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
    'gremse-altin':     { name: 'Gremse Altın',          code: 'GREMSE',  type: 'gold' },
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

// ── BIST hisse tablosu (Yahoo Finance .IS) — 97 likit hisse ───────────────────
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

// ── Ana fonksiyon ─────────────────────────────────────────────────────────────
async function run() {
    let current = {};
    try { current = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); } catch {}

    // Varlık başına tazelik damgası. Bir kaynak çökerse o varlıklar önceki
    // run'dan korunur ve ts'leri eskir; sağlıklı yazılanlarınki tazelenir.
    // Yazım anında damgalanır (fiyat değişiminde değil): piyasa kapalıyken
    // fiyat sabit kalsa da kaynak veri yazdığı sürece ts taze olur, böylece
    // hafta sonu yanlış "bayat" uyarısı üretilmez.
    const NOW = new Date().toISOString();

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
                ts: NOW,
                name: meta.name, code: meta.code, type: meta.type,
                current: satis, selling: satis,
                buying:  !isNaN(alis) && alis > 0 ? alis : parseFloat((satis * SPREAD_WIDE).toFixed(2)),
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
                ts: NOW,
                name: CURRENCY_NAMES[sym] || sym, code: sym, type: 'currency',
                current: satis, selling: satis,
                buying:  !isNaN(alis) && alis > 0 ? alis : parseFloat((satis * SPREAD_WIDE).toFixed(2)),
                change:  !isNaN(chg) ? chg : 0,
                // Değişim yüzdesinden türetilir; app mutlak fiyat farkını
                // ancak open > 0 iken gösterebiliyor.
                open:    !isNaN(chg) && chg !== -100
                    ? parseFloat((satis / (1 + chg / 100)).toFixed(4))
                    : satis
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
                // TCMB intraday change vermiyor; önceki run'daki gerçek değeri koru (yoksa 0).
                // open bu değişimden türetilir — böylece app'te gösterilen mutlak fark
                // ile yüzde birbiriyle tutarlı olur.
                const carriedChg = current[sym]?.change ?? 0;
                current[sym] = {
                    ts: NOW,
                    name: CURRENCY_NAMES[sym] || sym, code: sym, type: 'currency',
                    current: r.selling, selling: r.selling, buying: r.buying,
                    change: carriedChg,
                    open:   carriedChg !== -100
                        ? parseFloat((r.selling / (1 + carriedChg / 100)).toFixed(4))
                        : r.selling,
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
            // fawazahmed0 intraday change vermiyor; önceki run'daki gerçek değeri koru (yoksa 0).
            // open bundan türetilir ki gösterilen mutlak fark ile yüzde tutarlı olsun.
            const carriedChg = current[sym]?.change ?? 0;
            current[sym] = {
                ts: NOW,
                name: CURRENCY_NAMES[sym] || sym, code: sym, type: 'currency',
                current: rate, selling: rate,
                buying:  parseFloat((rate * SPREAD_TIGHT).toFixed(4)),
                change:  carriedChg,
                open:    carriedChg !== -100
                    ? parseFloat((rate / (1 + carriedChg / 100)).toFixed(4))
                    : rate,
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
            ts: NOW,
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

    // ── 3. Platin referansı (PL=F) ──────────────────────────────────────────────
    // Emtia varlıkları artık current.json'a YAZILMIYOR: app'te emtia sekmesi
    // kaldırıldı ve bu veriyi herkese açık bir URL'de yeniden yayınlamak
    // Yahoo'nun şartlarına aykırıydı. Yalnızca gram-platin'in yüzde değişimi
    // için PL=F fiyatı çekiliyor — değer dosyaya yazılmıyor, sadece hesapta
    // kullanılıyor, dolayısıyla yeniden dağıtım söz konusu değil.
    let platinUSD = 0, platinChg = 0;
    try {
        const plData = await fetchJson(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent('PL=F')}?interval=1d&range=2d`
        );
        const meta = plData.chart.result[0].meta;
        const px   = meta.regularMarketPrice;
        const prev = meta.chartPreviousClose || meta.previousClose;
        if (px > 0) {
            platinUSD = px;
            platinChg = prev ? parseFloat(((px - prev) / prev * 100).toFixed(2)) : 0;
            console.log(`  ✅ Platin referansı (PL=F): ${px} USD, %${platinChg}`);
        }
    } catch { console.warn('  ⚠️ PL=F alınamadı — gram-platin kendi değişimini kullanacak'); }

    // ── Truncgil-only varlıklar için change% senkronizasyonu ─────────────────
    // Truncgil'in row.Change alanı hafta sonu/tatil günü stale (son işlem günü değeri)
    // döndürebilir; Yahoo Finance / canlidoviz market kapalıyken doğru 0.00% verir.

    // gram-platin: % değişim PL=F (XPTUSD) ile aynı → Yahoo'dan al
    if (current['gram-platin'] && platinUSD > 0) {
        const chg   = platinChg;
        const satis = current['gram-platin'].current;
        current['gram-platin'].change = chg;
        current['gram-platin'].open   = chg !== -100
            ? parseFloat((satis / (1 + chg / 100)).toFixed(2))
            : satis;
    }

    // ons: % değişim gram-altin (canlidoviz) ile aynı — aynı underlying varlık
    if (current['ons'] && current['gram-altin']) {
        const chg   = current['gram-altin'].change;
        const satis = current['ons'].current;
        current['ons'].change = chg;
        current['ons'].open   = chg !== -100
            ? parseFloat((satis / (1 + chg / 100)).toFixed(2))
            : satis;
    }

    // ── Yahoo fallback: gram-platin ve ons ───────────────────────────────────
    // Yukarıdaki senkron blokları yalnızca varlık zaten yazılmışsa mutasyon
    // yapıyor. Truncgil çökerse bu ikisi hiç yazılmıyor ve önceki run'ın
    // değerleriyle sessizce bayat kalıyorlardı.
    const TROY_OZ_GRAMS = 31.1035;

    // gram-platin ← PL=F (XPTUSD zaten emtia adımında çekildi), USD/ons → gram TRY
    if (current['gram-platin']?.ts !== NOW && platinUSD > 0) {
        const gramTRY = platinUSD / TROY_OZ_GRAMS * usdTry;
        const chg     = platinChg;
        current['gram-platin'] = {
            ts: NOW,
            name: 'Gram Platin', code: 'PLATIN', type: 'commodity',
            current: parseFloat(gramTRY.toFixed(2)),
            selling: parseFloat(gramTRY.toFixed(2)),
            buying:  parseFloat((gramTRY * SPREAD_WIDE).toFixed(2)),
            change:  chg,
            open:    chg !== -100 ? parseFloat((gramTRY / (1 + chg / 100)).toFixed(2)) : parseFloat(gramTRY.toFixed(2)),
        };
        console.log('  ↩️  gram-platin Yahoo (PL=F) fallback ile yazıldı');
    }

    // ons ← GC=F (altın futures, USD/ons) → TRY/ons
    if (current['ons']?.ts !== NOW) {
        const gcData = await fetchJson(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent('GC=F')}?interval=1d&range=2d`
        );
        try {
            const meta  = gcData.chart.result[0].meta;
            const price = meta.regularMarketPrice;
            const prev  = meta.chartPreviousClose || meta.previousClose;
            if (price > 0) {
                const onsTRY = price * usdTry;
                const chg    = prev ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0;
                current['ons'] = {
                    ts: NOW,
                    name: 'Ons Altın', code: 'ONS', type: 'gold',
                    current: parseFloat(onsTRY.toFixed(2)),
                    selling: parseFloat(onsTRY.toFixed(2)),
                    buying:  parseFloat((onsTRY * SPREAD_WIDE).toFixed(2)),
                    change:  chg,
                    open:    prev ? parseFloat((prev * usdTry).toFixed(2)) : 0,
                };
                console.log('  ↩️  ons Yahoo (GC=F) fallback ile yazıldı');
            }
        } catch { /* GC=F de alınamadı — önceki değer korunur */ }
    }

    // ── BIST hisseleri kaldırıldı ───────────────────────────────────────────────
    // Hisse listesi artık uygulamada TradingView gömülü widget'ından gösteriliyor.
    // Veriyi kendi sunucumuzda çekip yeniden yayınlamak, incelenen tüm
    // sağlayıcıların (Yahoo dahil) şartlarına aykırıydı.

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
        // Kripto 24/7 işlem gördüğü için "seans açılışı" yok; referans 24 saat
        // önceki fiyat (change ile aynı temel) ve değişimden türetiliyor.
        const openTRY = chg > -100
            ? parseFloat((raw / (1 + chg / 100)).toFixed(decimals))
            : 0;
        current[meta.key] = {
            ts: NOW,
            name: meta.name, code: meta.code, type: 'crypto',
            current: priceTRY, selling: priceTRY, buying: priceTRY,
            change: chg, open: openTRY, priceUSD: parseFloat(priceUSD.toFixed(8))
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

    // Yahoo fallback KALDIRILDI (2026-08).
    // Neden: CoinGecko başarısız olduğunda Yahoo'dan çekilen kripto fiyatları da
    // data/current.json'a yazılıyordu; bu dosya herkese açık yayınlandığı için
    // Yahoo verisini YENİDEN DAĞITMIŞ oluyorduk — BIST hisse ve emtia için
    // kaldırdığımız sorunun aynısı. CoinGecko sağlıklı çalıştığı için
    // (ölçüldü: 3/3 HTTP 200, 20/20 coin dolu) fallback'e gerek yok.
    //
    // CoinGecko düşerse ne olur: kriptolar önceki run'ın değerleriyle kalır ve
    // _meta.counts.crypto = 0 olur; bu da _meta.warnings'e düşüp uygulamada
    // "veriler güncellenemedi" uyarısı gösterir. Yani sessiz bayatlama yok.
    if (!geckoOk) {
        console.warn("  ⚠️ CoinGecko alınamadı — kripto değerleri önceki run'dan korunuyor (fallback yok)");
    }

    // ── History üretimi (adım 5-6-7) ─────────────────────────────────────────
    // SKIP_HISTORY=1 ile atlanır. 5 dakikalık fiyat run'ı bu adımları atlar:
    // her çalıştırmada ~962 dosya değiştirip repoyu şişiriyor ve run'a ~45 sn
    // ekliyorlardı. History'yi saatlik workflow bayraksız çalışıp üretir.
    const SKIP_HISTORY = process.env.SKIP_HISTORY === '1';
    if (SKIP_HISTORY) {
        console.log('⏭️  SKIP_HISTORY=1 — history üretimi atlanıyor (adım 5-6-7)');
    }

    // ── 5. History cache (GitHub Pages CDN) ──────────────────────────────────
    // Her varlığın GÜN/HAFTA/AY/YIL geçmişi data/history/{sembol}-{aralık}.json'a yazılır.
    // Android app önce buradan okur; Yahoo Finance sadece fallback olarak kullanılır.
    const ALL_YAHOO_SYMBOLS = [...new Set([
        'GC=F', 'SI=F', 'PL=F',                       // Altın / gümüş / platin (sentetik gram history için)
        // Emtia ve BIST hisse sembolleri çıkarıldı: artık yayınlanmıyorlar.
        ...FOREX_YAHOO_SYMBOLS,                          // Döviz (TRY bazlı)
        // Kripto history'si de kaldırıldı: Yahoo'dan çekilip data/history/
        // altında yayınlanıyordu — fiyat fallback'iyle aynı yeniden dağıtım
        // sorunu. Uygulama kripto grafiği için Yahoo'ya doğrudan düşer
        // (cihazdan tek kullanıcılık istek; yeniden yayın değil).
    ])];

    const HISTORY_RANGES = [
        { name: 'gun',   interval: '5m',  yahooRange: '1d'  },
        { name: 'hafta', interval: '1d',  yahooRange: '7d'  },
        { name: 'ay',    interval: '1d',  yahooRange: '1mo' },
        { name: 'yil',   interval: '1wk', yahooRange: '1y'  },
    ];

    if (!SKIP_HISTORY) {
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
    }

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
        'gremse-altin':      'GC=F',
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
    if (!SKIP_HISTORY) {
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
    }

    // ── 7. Gerçek piyasa history overlay (accumulator'dan) ───────────────────
    // data/history.json'da build_history.js'in 3+ yıldır biriktirdiği gerçek
    // piyasa kapanışları var (ata/reşat/hamit gibi sikkelerin kendi premium'lu
    // değerleri). Sentetik dosyaların üstüne yazıp gerçek seriyi sun.
    if (!SKIP_HISTORY) {
        let realHistoryWritten = 0;
        try {
            const accumulator = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            // TÜM varlıklar için overlay — sadece altın değil; ata/reşat ekstra önemli.
            for (const [key, h] of Object.entries(accumulator)) {
                if (key.startsWith('_') || !h || typeof h !== 'object') continue;
                // gun: hourly (24'e kadar)  — en azından 2 nokta varsa
                if (h.hourly  && h.hourly.length  >= 2 && writeRealHistoryFromAccumulator(key, 'gun',   h.hourly, h.hourlyTs))  realHistoryWritten++;
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
    }

    // ── Meta bilgisi ekle ve kaydet ───────────────────────────────────────────
    current['_daily_open'] = dailyOpen;
    // ── Artık yayınlanmayan varlıkları dosyadan temizle ─────────────────────────
    // current nesnesi önceki dosyadan yükleniyor; hisse ve Yahoo emtia kayıtları
    // üretilmeyi bıraktıktan sonra da dosyada kalıyor, yani yeniden dağıtım
    // sürüyor ve "bayat varlık" uyarısı üretiyorlardı. Açıkça siliyoruz.
    // gumus ve gram-platin KALIR: onlar Truncgil/canlidoviz kaynaklı.
    const KALDIRILACAK_EMTIA = [
        'XAGUSD', 'XPTUSD', 'XPDUSD', 'XBRUSD', 'COIL', 'COPPER', 'NGAS',
        'WHEAT', 'CORN', 'COFFEE', 'SUGAR', 'COCOA', 'SOYBEAN', 'COTTON',
    ];
    let temizlenen = 0;
    for (const k of Object.keys(current)) {
        if (k.startsWith('_')) continue;
        const v = current[k];
        if (!v || typeof v !== 'object') continue;
        if (v.type === 'stock' || KALDIRILACAK_EMTIA.includes(k)) {
            delete current[k];
            temizlenen++;
        }
    }
    if (temizlenen > 0) {
        console.log(`  🧹 Yayından kaldırılan varlık temizlendi: ${temizlenen}`);
    }

    // Kaynak sağlık raporu. Bir kaynak çökerse eski değerler korunuyor (kasıtlı),
    // ama updated_at yine de tazeleniyor — bu, donmuş fiyatları "az önce
    // güncellendi" gibi gösteriyordu. Sayaçlar hangi kaynağın bu run'da gerçekten
    // veri yazdığını söyler; 0 olan bir kategori sessiz bayatlama demektir.
    const counts = {
        gold:      goldCount,
        crypto:    cryptoCount,
        currency:  writtenCurrencies.size,
    };
    const warnings = Object.entries(counts)
        .filter(([, n]) => n === 0)
        .map(([k]) => `${k}: bu run'da hiç veri yazılmadı — değerler önceki run'dan geliyor`);

    // Desteklenmeyen dövizleri current.json'dan TEMİZLE.
    //
    // Truncgil V3 84 kalem döviz dönüyor; desteklediğimiz (CURRENCY_NAMES)
    // 29 tanesi. Fazlası bir kez yazılıp dosyada kalıyor ve BİR DAHA HİÇ
    // güncellenmiyordu: Truncgil CI'dan ara ara erişilemiyor, o durumda
    // devreye giren TCMB/fawazahmed0 yedekleri yalnızca CURRENCY_NAMES'i
    // kapsıyor.
    //
    // Sonuç kullanıcıya yansıyordu: bu ölü kayıtlar stale_assets sayacını
    // sürekli şişiriyor, uygulama da uyarı bandını gösteriyordu — üstelik
    // uygulamanın EKRANDA GÖSTERMEDİĞİ dövizler yüzünden. Ölçüldü: bayat
    // 32 kaydın hiçbiri uygulamada listelenmiyor.
    for (const k of Object.keys(current)) {
        const v = current[k];
        if (k.startsWith('_') || !v || typeof v !== 'object') continue;
        if (v.type !== 'currency') continue;
        if (!CURRENCY_NAMES[k]) delete current[k];
    }

    // Bu run'da yazılamayan (ts'i eskimiş) varlıklar. Kategori sayacı sıfır
    // olmasa bile tek tek varlıklar geride kalmış olabilir.
    // ts hiç yoksa da bayattır: o varlık bu run'da (ve ts özelliği eklendiğinden
    // beri hiçbir run'da) yazılmamış demektir.
    const STALE_MS = 2 * 60 * 60 * 1000;
    const staleAssets = Object.entries(current)
        .filter(([k, v]) => {
            if (k.startsWith('_') || !v || typeof v !== 'object') return false;
            if (!v.ts) return true;
            return (Date.parse(NOW) - Date.parse(v.ts)) > STALE_MS;
        })
        .map(([k]) => k);
    if (staleAssets.length) {
        warnings.push(`${staleAssets.length} varlık 2 saatten uzun süredir güncellenmedi`);
    }

    current['_meta'] = {
        updated_at: new Date().toISOString(),
        source: 'canlidoviz (altın) | Truncgil V3 (ons+platin+döviz) | Yahoo Finance (emtia+hisse) | CoinGecko (kripto)',
        counts,
        stale_assets: staleAssets.length,
        ...(warnings.length ? { warnings } : {}),
    };

    if (warnings.length) {
        console.warn(`\n⚠️  KAYNAK UYARISI:\n   ${warnings.join('\n   ')}`);
    }

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
