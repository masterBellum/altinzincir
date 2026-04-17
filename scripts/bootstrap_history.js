/**
 * bootstrap_history.js
 * ─────────────────────────────────────────────────────────────────────────────
 * TEK SEFERLİK çalıştırılır. Tüm varlıklar için 5 yıllık tarihsel veri çeker:
 *
 *   ALTIN    → Yahoo Finance GC=F × USDTRY=X → gram TRY hesabı
 *              (altın.in scraping eklenmek üzere ayrıca işaretlendi)
 *   DÖVİZ    → Yahoo Finance *TRY=X çiftleri (27 döviz)
 *   KRİPTO   → Binance klines (20 coin, USD → TRY çevrilir)
 *   HİSSE    → Yahoo Finance *.IS (24 BIST hissesi)
 *   EMTİA    → Yahoo Finance vadeli semboller
 *
 * Çıktı: data/history.json
 * Format her varlık için:
 *   { daily: [float,...], monthly: [float,...], yearly: [float,...] }
 *   daily   → son 1825 günlük kapanış (~5 yıl)
 *   monthly → her ayın son kapanışı (max 60 ay)
 *   yearly  → her yılın son kapanışı (max 5 yıl)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs    = require('fs');
const https = require('https');
const path  = require('path');

const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.json');

// Yahoo Finance / diğer kaynaklarda veri olmayan, desteklenmeyen para birimleri
const BLACKLIST = new Set(['AZN', 'BAM', 'GEL', 'SYP']);

// ── HTTP yardımcısı ───────────────────────────────────────────────────────────
function fetchJson(url, extraHeaders = {}) {
    return new Promise(resolve => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/json,*/*',
                ...extraHeaders
            }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchJson(res.headers.location, extraHeaders).then(resolve);
            }
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch { resolve(null); }
            });
        });
        req.on('error', e => { console.error('  fetch error:', url.slice(0, 80), e.message); resolve(null); });
        req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    });
}

/** ms bekleme (rate limit önlemi) */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Yahoo Finance yardımcıları ────────────────────────────────────────────────
function yahooUrl(symbol, range = '5y', interval = '1d') {
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
}

/** Yahoo response → [{ts:ms, open, high, low, close}] */
function parseYahooOHLC(data) {
    try {
        const r          = data.chart.result[0];
        const timestamps = r.timestamp;
        const q          = r.indicators.quote[0];
        const result     = [];
        for (let i = 0; i < timestamps.length; i++) {
            const c = q.close[i];
            if (c == null || isNaN(c) || c <= 0) continue;
            result.push({
                ts:    timestamps[i] * 1000,
                open:  q.open[i]  || c,
                high:  q.high[i]  || c,
                low:   q.low[i]   || c,
                close: c
            });
        }
        return result;
    } catch { return []; }
}


// ── Rollup: ham seri → {daily, monthly, yearly} ───────────────────────────────
function buildArrays(series) {
    if (!series.length) return { daily: [], monthly: [], yearly: [] };

    // Günlük — son 1825 gün (5 yıl)
    const daily = series.slice(-1825).map(x => parseFloat(x.close.toFixed(4)));

    // Aylık — her ayın son kapanışı, max 60 ay
    const byMonth = {};
    series.forEach(({ ts, close }) => {
        const d   = new Date(ts);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        byMonth[key] = parseFloat(close.toFixed(4));
    });
    const monthly = Object.keys(byMonth).sort().slice(-60).map(k => byMonth[k]);

    // Yıllık — her yılın son kapanışı, max 5 yıl
    const byYear = {};
    series.forEach(({ ts, close }) => {
        byYear[new Date(ts).getUTCFullYear()] = parseFloat(close.toFixed(4));
    });
    const yearly = Object.keys(byYear).sort().slice(-5).map(k => byYear[k]);

    return { daily, monthly, yearly };
}

// ── Ana fonksiyon ─────────────────────────────────────────────────────────────
async function run() {
    let history = {};
    try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        console.log('✅ Mevcut history.json yüklendi');
    } catch {
        console.log('ℹ️ history.json yok, sıfırdan oluşturuluyor');
    }

    function merge(key, series) {
        if (BLACKLIST.has(key)) { console.log(`  🚫 ${key}: kara listede, atlandı`); return; }
        if (!series || !series.length) { console.log(`  ⚠️  ${key}: veri yok, atlandı`); return; }
        const arrays = buildArrays(series);
        if (!history[key]) history[key] = { daily: [], monthly: [], yearly: [] };
        // Daha uzun veriyi koru
        if (arrays.daily.length   >= (history[key].daily   || []).length) history[key].daily   = arrays.daily;
        if (arrays.monthly.length >= (history[key].monthly || []).length) history[key].monthly = arrays.monthly;
        if (arrays.yearly.length  >= (history[key].yearly  || []).length) history[key].yearly  = arrays.yearly;
        console.log(`  ✅ ${key.padEnd(22)} daily=${arrays.daily.length}  monthly=${arrays.monthly.length}  yearly=${arrays.yearly.length}`);
    }

    // ────────────────────────────────────────────────────────────────────────
    // BÖLÜM 1 — USD/TRY (her şey için baz kur)
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n═══ 1/5  USD/TRY kuru ═══');
    const usdtryRaw    = await fetchJson(yahooUrl('USDTRY=X'));
    const usdtrySeries = parseYahooOHLC(usdtryRaw || {});
    console.log(`  USDTRY: ${usdtrySeries.length} gün`);

    // Tarih → USD/TRY haritası (kripto dönüşümü için)
    const usdMap = {};
    usdtrySeries.forEach(({ ts, close }) => {
        usdMap[new Date(ts).toISOString().slice(0, 10)] = close;
    });

    merge('USD', usdtrySeries);
    await sleep(500);

    // ────────────────────────────────────────────────────────────────────────
    // BÖLÜM 2 — ALTIN (Yahoo GC=F × USDTRY)
    // TODO: altın.in scraping ile değiştirilebilir — daha doğru TL fiyatları
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n═══ 2/5  Altın ═══');
    const goldRaw    = await fetchJson(yahooUrl('GC=F'));
    const goldSeries = parseYahooOHLC(goldRaw || {});
    console.log(`  GC=F: ${goldSeries.length} gün`);
    await sleep(500);

    // Gram altın TRY = (ons USD × USDTRY) / 31.1035
    const gramSeries = goldSeries.map(({ ts, close: onsUSD }) => {
        const dateKey = new Date(ts).toISOString().slice(0, 10);
        const rate    = usdMap[dateKey];
        if (!rate) return null;
        return { ts, close: (onsUSD * rate) / 31.1035 };
    }).filter(Boolean);

    merge('gram-altin', gramSeries);
    // Ons altın USD fiyatı (current.json'da 'ons' key'i)
    merge('ons', goldSeries);

    // Diğer altın türleri gram altın üzerinden katsayıyla hesaplanır
    // (grafik amaçlı — yeterince doğru)
    const GOLD_RATIOS = {
        'ceyrek-altin':      1.75,    // ~1.75 gram (22 ayar)
        'yarim-altin':       3.5,
        'tam-altin':         7.0,
        'cumhuriyet-altini': 7.0,
        'ata-altin':         7.0,
        'resat-altin':       7.2,
        'hamit-altin':       7.2,
        'gram-has-altin':    1.0,
        '14-ayar-altin':     0.585,
        '18-ayar-altin':     0.750,
        '22-ayar-bilezik':   0.917,
    };
    for (const [key, ratio] of Object.entries(GOLD_RATIOS)) {
        const scaled = gramSeries.map(({ ts, close }) => ({ ts, close: close * ratio }));
        merge(key, scaled);
    }

    // Gümüş
    console.log('  Fetching: SI=F (Gümüş)...');
    const silverRaw = await fetchJson(yahooUrl('SI=F'));
    const silverOHLC = parseYahooOHLC(silverRaw || {});
    // Gümüş: troy ons USD → gram TRY
    const silverGramSeries = silverOHLC.map(({ ts, close: onsUSD }) => {
        const dateKey = new Date(ts).toISOString().slice(0, 10);
        const rate    = usdMap[dateKey];
        if (!rate) return null;
        return { ts, close: (onsUSD * rate) / 31.1035 };
    }).filter(Boolean);
    merge('gumus', silverGramSeries);
    await sleep(500);

    // Gram platin
    console.log('  Fetching: PL=F (Platin)...');
    const platRaw  = await fetchJson(yahooUrl('PL=F'));
    const platOHLC = parseYahooOHLC(platRaw || {});
    const platGramSeries = platOHLC.map(({ ts, close: onsUSD }) => {
        const dateKey = new Date(ts).toISOString().slice(0, 10);
        const rate    = usdMap[dateKey];
        if (!rate) return null;
        return { ts, close: (onsUSD * rate) / 31.1035 };
    }).filter(Boolean);
    merge('gram-platin', platGramSeries);
    await sleep(500);

    // ────────────────────────────────────────────────────────────────────────
    // BÖLÜM 3 — DÖVİZ (current.json'daki tüm dövizler)
    // ────────────────────────────────────────────────────────────────────────
    // Strateji: XXXUSD=X çek → usdMap ile × USDTRY → TRY fiyatı
    // (XXXTRY=X çiftleri Yahoo'da çoğu zaman mevcut değil)
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n═══ 3/5  Döviz (USD üzerinden TRY) ═══');

    // EURUSD=X gibi çiftler zaten USD base — direkt çarp
    // Ters çiftler (USDJPY=X): close = USDJPY → 1/close = JPYUSD → × USDTRY
    const FOREX_PAIRS = [
        { yahoo: 'USDTRY=X',  key: 'USD',  direct: true  }, // zaten TRY
        { yahoo: 'EURUSD=X',  key: 'EUR'  },
        { yahoo: 'GBPUSD=X',  key: 'GBP'  },
        { yahoo: 'USDJPY=X',  key: 'JPY',  invert: true  },
        { yahoo: 'CHFUSD=X',  key: 'CHF'  },
        { yahoo: 'CADUSD=X',  key: 'CAD'  },
        { yahoo: 'AUDUSD=X',  key: 'AUD'  },
        { yahoo: 'NZDUSD=X',  key: 'NZD'  },
        { yahoo: 'SEKUSD=X',  key: 'SEK'  },
        { yahoo: 'NOKUSD=X',  key: 'NOK'  },
        { yahoo: 'DKKUSD=X',  key: 'DKK'  },
        { yahoo: 'RUBUSD=X',  key: 'RUB'  },
        { yahoo: 'CNYUSD=X',  key: 'CNY'  },
        { yahoo: 'HKDUSD=X',  key: 'HKD'  },
        { yahoo: 'SGDUSD=X',  key: 'SGD'  },
        { yahoo: 'INRUSD=X',  key: 'INR'  },
        { yahoo: 'SARUSD=X',  key: 'SAR'  },
        { yahoo: 'AEDUSD=X',  key: 'AED'  },
        { yahoo: 'KWDUSD=X',  key: 'KWD'  },
        { yahoo: 'ZARUSD=X',  key: 'ZAR'  },
        { yahoo: 'BRLUSD=X',  key: 'BRL'  },
        { yahoo: 'MXNUSD=X',  key: 'MXN'  },
        { yahoo: 'ILSUSD=X',  key: 'ILS'  },
        { yahoo: 'PLNUSD=X',  key: 'PLN'  },
        { yahoo: 'CZKUSD=X',  key: 'CZK'  },
        { yahoo: 'HUFUSD=X',  key: 'HUF'  },
        { yahoo: 'RONUSD=X',  key: 'RON'  },
        { yahoo: 'QARUSD=X',  key: 'QAR'  },
        { yahoo: 'MYRUSD=X',  key: 'MYR'  },
        { yahoo: 'THBUSD=X',  key: 'THB'  },
        { yahoo: 'IDRUSD=X',  key: 'IDR'  },
        { yahoo: 'PHPUSD=X',  key: 'PHP'  },
        { yahoo: 'PKRUSD=X',  key: 'PKR'  },
        { yahoo: 'KRWUSD=X',  key: 'KRW'  },
        { yahoo: 'TWDUSD=X',  key: 'TWD'  },
        { yahoo: 'ISKUSD=X',  key: 'ISK'  },
        { yahoo: 'BGNUSD=X',  key: 'BGN'  },
        { yahoo: 'RSDUSD=X',  key: 'RSD'  },
        { yahoo: 'MDLUSD=X',  key: 'MDL'  },
        { yahoo: 'MKDUSD=X',  key: 'MKD'  },
        { yahoo: 'ALLUSD=X',  key: 'ALL'  },
        { yahoo: 'BAMUSD=X',  key: 'BAM'  },
        { yahoo: 'AZNUSD=X',  key: 'AZN'  },
        { yahoo: 'GELUSD=X',  key: 'GEL'  },
        { yahoo: 'UAHUSD=X',  key: 'UAH'  },
        { yahoo: 'KZTUSD=X',  key: 'KZT'  },
        { yahoo: 'OMRUSD=X',  key: 'OMR'  },
        { yahoo: 'BHDUSD=X',  key: 'BHD'  },
        { yahoo: 'EGPUSD=X',  key: 'EGP'  },
        { yahoo: 'MADUSD=X',  key: 'MAD'  },
        { yahoo: 'DZDUSD=X',  key: 'DZD'  },
        { yahoo: 'TNDUSD=X',  key: 'TND'  },
        { yahoo: 'LKRUSD=X',  key: 'LKR'  },
        { yahoo: 'COPUSD=X',  key: 'COP'  },
        { yahoo: 'CLPUSD=X',  key: 'CLP'  },
        { yahoo: 'PENUSD=X',  key: 'PEN'  },
        { yahoo: 'UYUUSD=X',  key: 'UYU'  },
        { yahoo: 'ARSUSD=X',  key: 'ARS'  },
        { yahoo: 'LYDUSD=X',  key: 'LYD'  },
        { yahoo: 'IQDUSD=X',  key: 'IQD'  },
        { yahoo: 'CRCUSD=X',  key: 'CRC'  },
        { yahoo: 'LBPUSD=X',  key: 'LBP'  },
        { yahoo: 'SYPUSD=X',  key: 'SYP'  },
    ];

    for (const pair of FOREX_PAIRS) {
        if (pair.direct) { merge(pair.key, usdtrySeries); continue; }
        console.log(`  Fetching: ${pair.yahoo}...`);
        const raw    = await fetchJson(yahooUrl(pair.yahoo));
        const ohlc   = parseYahooOHLC(raw || {});
        // USD fiyatını TRY'ye çevir
        const series = ohlc.map(({ ts, close: priceUSD }) => {
            const dateKey = new Date(ts).toISOString().slice(0, 10);
            const rate    = usdMap[dateKey];
            if (!rate) return null;
            const usdVal  = pair.invert ? (1 / priceUSD) : priceUSD;
            return { ts, close: usdVal * rate };
        }).filter(Boolean);
        merge(pair.key, series);
        await sleep(400);
    }

    // ────────────────────────────────────────────────────────────────────────
    // BÖLÜM 4 — KRİPTO (CryptoCompare histoday — API key gerektirmez)
    // https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=2000
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n═══ 4/5  Kripto (CryptoCompare histoday, 20 coin) ═══');

    const CRYPTO_LIST = [
        { cc: 'BTC',   key: 'btc'   },
        { cc: 'ETH',   key: 'eth'   },
        { cc: 'BNB',   key: 'bnb'   },
        { cc: 'SOL',   key: 'sol'   },
        { cc: 'XRP',   key: 'xrp'   },
        { cc: 'DOGE',  key: 'doge'  },
        { cc: 'LTC',   key: 'ltc'   },
        { cc: 'ADA',   key: 'ada'   },
        { cc: 'AVAX',  key: 'avax'  },
        { cc: 'DOT',   key: 'dot'   },
        { cc: 'LINK',  key: 'link'  },
        { cc: 'ATOM',  key: 'atom'  },
        { cc: 'TRX',   key: 'trx'   },
        { cc: 'MATIC', key: 'matic' },
        { cc: 'SHIB',  key: 'shib'  },
        { cc: 'NEAR',  key: 'near'  },
        { cc: 'UNI',   key: 'uni'   },
        { cc: 'ARB',   key: 'arb'   },
        { cc: 'TON',   key: 'ton'   },
        { cc: 'SUI',   key: 'sui'   },
    ];

    for (const coin of CRYPTO_LIST) {
        console.log(`  Fetching CryptoCompare: ${coin.cc}...`);
        const url  = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${coin.cc}&tsym=USD&limit=2000`;
        const data = await fetchJson(url);
        if (!data || data.Response === 'Error' || !data.Data?.Data?.length) {
            console.log(`  ⚠️  ${coin.key}: veri yok (${data?.Message || '?'})`);
            await sleep(500);
            continue;
        }

        // CryptoCompare: [{time: unix_sec, close: price}, ...]
        const trySeries = data.Data.Data.map(({ time, close: priceUSD }) => {
            if (!priceUSD || priceUSD <= 0) return null;
            const ts      = time * 1000;
            const dateKey = new Date(ts).toISOString().slice(0, 10);
            const rate    = usdMap[dateKey];
            if (!rate) return null;
            return { ts, close: priceUSD * rate };
        }).filter(Boolean);

        merge(coin.key, trySeries);
        await sleep(300);
    }

    // ────────────────────────────────────────────────────────────────────────
    // BÖLÜM 5 — HİSSE (24 BIST) + EMTİA (13 sembol)
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n═══ 5/5  BIST Hisseleri + Emtia ═══');
    const YAHOO_ASSETS = [
        // BIST
        { yahoo: 'GARAN.IS', key: 'garan' }, { yahoo: 'AKBNK.IS', key: 'akbnk' },
        { yahoo: 'YKBNK.IS', key: 'ykbnk' }, { yahoo: 'ISCTR.IS', key: 'isctr' },
        { yahoo: 'HALKB.IS', key: 'halkb' }, { yahoo: 'VAKBN.IS', key: 'vakbn' },
        { yahoo: 'THYAO.IS', key: 'thyao' }, { yahoo: 'ASELS.IS', key: 'asels' },
        { yahoo: 'EREGL.IS', key: 'eregl' }, { yahoo: 'SISE.IS',  key: 'sise'  },
        { yahoo: 'KCHOL.IS', key: 'kchol' }, { yahoo: 'SAHOL.IS', key: 'sahol' },
        { yahoo: 'TUPRS.IS', key: 'tuprs' }, { yahoo: 'TOASO.IS', key: 'toaso' },
        { yahoo: 'FROTO.IS', key: 'froto' }, { yahoo: 'OTKAR.IS', key: 'otkar' },
        { yahoo: 'TCELL.IS', key: 'tcell' }, { yahoo: 'TTKOM.IS', key: 'ttkom' },
        { yahoo: 'LOGO.IS',  key: 'logo'  }, { yahoo: 'ENKAI.IS', key: 'enkai' },
        { yahoo: 'BIMAS.IS', key: 'bimas' }, { yahoo: 'MGROS.IS', key: 'mgros' },
        { yahoo: 'PGSUS.IS', key: 'pgsus' }, { yahoo: 'ULKER.IS', key: 'ulker' },
        // Emtia (USD fiyatı — current.json'daki key'lerle eşleştirildi)
        { yahoo: 'CL=F',  key: 'COIL',    usdToTry: true },   // WTI Ham Petrol
        { yahoo: 'BZ=F',  key: 'XBRUSD',  usdToTry: true },   // Brent
        { yahoo: 'NG=F',  key: 'NGAS',    usdToTry: true },   // Doğal Gaz
        { yahoo: 'HG=F',  key: 'COPPER',  usdToTry: true },   // Bakır
        { yahoo: 'PA=F',  key: 'XPDUSD',  usdToTry: true },   // Paladyum
        { yahoo: 'KC=F',  key: 'COFFEE',  usdToTry: true },   // Kahve
        { yahoo: 'ZW=F',  key: 'WHEAT',   usdToTry: true },   // Buğday
        { yahoo: 'ZC=F',  key: 'CORN',    usdToTry: true },   // Mısır
        { yahoo: 'ZS=F',  key: 'SOYBEAN', usdToTry: true },   // Soya
        { yahoo: 'SB=F',  key: 'SUGAR',   usdToTry: true },   // Şeker
        { yahoo: 'CT=F',  key: 'COTTON',  usdToTry: true },   // Pamuk
        { yahoo: 'CC=F',  key: 'COCOA',   usdToTry: true },   // Kakao
        { yahoo: 'SI=F',  key: 'XAGUSD',  usdOnly: true  },   // Gümüş (USD)
        { yahoo: 'PL=F',  key: 'XPTUSD',  usdOnly: true  },   // Platin (USD)
    ];

    for (const asset of YAHOO_ASSETS) {
        console.log(`  Fetching: ${asset.yahoo}...`);
        const raw    = await fetchJson(yahooUrl(asset.yahoo));
        const series = parseYahooOHLC(raw || {});

        let finalSeries = series;
        if (asset.usdToTry) {
            finalSeries = series.map(({ ts, close: priceUSD }) => {
                const dateKey = new Date(ts).toISOString().slice(0, 10);
                const rate    = usdMap[dateKey];
                if (!rate) return null;
                return { ts, close: priceUSD * rate };
            }).filter(Boolean);
        } else if (asset.usdOnly) {
            // USD fiyatı olduğu gibi sakla (XAGUSD, XPTUSD gibi)
            finalSeries = series;
        }

        merge(asset.key, finalSeries);
        await sleep(400);
    }

    // ── Meta + Kaydet ─────────────────────────────────────────────────────────
    history['_meta'] = {
        ...history['_meta'],
        bootstrapped_at: new Date().toISOString(),
        sources: 'Yahoo Finance (altın/döviz/hisse/emtia) | Binance klines (kripto)',
        note:    'Altın verileri GC=F×USDTRY hesabıdır. altın.in ile güncellenebilir.'
    };

    // Kara listedeki anahtarları temizle (önceki bootstrap'tan kalmış olabilir)
    for (const k of BLACKLIST) delete history[k];

    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    const tmpFile = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(history), 'utf8');
    fs.renameSync(tmpFile, HISTORY_FILE);

    const keys = Object.keys(history).filter(k => k !== '_meta');
    const totalSize = (Buffer.byteLength(JSON.stringify(history)) / 1024).toFixed(1);
    console.log(`\n✅ data/history.json kaydedildi — ${keys.length} varlık, ${totalSize} KB`);
}

run().catch(err => {
    console.error('❌ Hata:', err);
    process.exit(1);
});
