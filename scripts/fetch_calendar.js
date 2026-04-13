/**
 * fetch_calendar.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Her 6 saatte GitHub Actions tarafından çalıştırılır.
 * Financial Modeling Prep (FMP) resmi API'sinden ekonomik takvim verisi çeker.
 *
 * Kaynak: https://financialmodelingprep.com/api/v3/economic_calendar
 *
 * Çıktı: data/calendar.json
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs    = require('fs');
const https = require('https');
const path  = require('path');

const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'calendar.json');
const API_KEY     = process.env.FMP_API_KEY;

if (!API_KEY) { console.error('FMP_API_KEY eksik'); process.exit(1); }

const IMPORTANT_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CHF'];
const HIGH_IMPACT_ONLY     = ['High', 'Medium'];

// FMP country code → currency map
const COUNTRY_TO_CURRENCY = {
  'US': 'USD', 'EU': 'EUR', 'GB': 'GBP', 'JP': 'JPY',
  'CN': 'CNY', 'CH': 'CHF', 'DE': 'EUR', 'FR': 'EUR'
};

const IMPACT_TR = { 'High': 'Yüksek', 'Medium': 'Orta', 'Low': 'Düşük' };
const IMPACT_NUM = { 'High': 3, 'Medium': 2, 'Low': 1 };

function fetchJson(url) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

async function run() {
  const now      = new Date();
  const from     = now.toISOString().split('T')[0];
  const to       = new Date(now.getTime() + 14 * 86400000).toISOString().split('T')[0];

  const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${API_KEY}`;
  console.log(`📅 FMP ekonomik takvim çekiliyor (${from} → ${to})...`);

  const res = await fetchJson(url);
  if (!res || res.status !== 200 || !Array.isArray(res.data)) {
    console.error('❌ FMP API hatası:', res?.status, JSON.stringify(res?.data));
    process.exit(1);
  }

  console.log(`  Toplam ${res.data.length} etkinlik`);

  const events = res.data
    .filter(e => {
      const currency = e.currency || COUNTRY_TO_CURRENCY[e.country] || '';
      return IMPORTANT_CURRENCIES.includes(currency) && HIGH_IMPACT_ONLY.includes(e.impact);
    })
    .map(e => {
      const currency = e.currency || COUNTRY_TO_CURRENCY[e.country] || e.country;
      return {
        id:        `${currency}-${e.event}-${e.date}`.replace(/s+/g, '-').toLowerCase().slice(0, 40),
        country:   currency,
        event:     e.event    || '',
        time:      e.date     || '',
        impact:    IMPACT_TR[e.impact] || e.impact,
        impactNum: IMPACT_NUM[e.impact] || 0,
        actual:    e.actual   || null,
        estimate:  e.estimate || null,
        prev:      e.previous || null,
        unit:      ''
      };
    })
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  const output = {
    _meta: {
      updated_at: now.toISOString(),
      range_from: from,
      range_to:   to,
      count:      events.length,
      source:     'Financial Modeling Prep (financialmodelingprep.com)'
    },
    events
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`✅ data/calendar.json kaydedildi (${events.length} etkinlik)`);
}

run().catch(err => { console.error('❌ Hata:', err); process.exit(1); });
