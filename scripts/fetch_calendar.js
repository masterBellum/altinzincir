/**
 * fetch_calendar.js — Ekonomik takvim
 *
 * Kaynak: ForexFactory haftalık JSON feed'i (nfs.faireconomy.media).
 * API anahtarı gerektirmez. Önceki takvim scripti FinancialModelingPrep
 * kullanıyordu ve anahtar gerektiriyordu; 2026-04-13'te kaldırılmıştı.
 *
 * Çıktı: data/economic-calendar.json
 * Android app tam olarak bu dosya adını ve bu şemayı bekliyor
 * (EconomicCalendarRepository): kök anahtar "economicCalendar", zaman
 * "yyyy-MM-dd HH:mm:ss" biçiminde UTC, actual/estimate/prev SAYI.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const FEED_URL    = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'economic-calendar.json');

function fetchJson(url) {
    return new Promise(resolve => {
        const req = https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AltinZincir/1.0)' }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchJson(res.headers.location).then(resolve);
            }
            if (res.statusCode !== 200) { res.resume(); return resolve(null); }
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    });
}

/**
 * "5.7%" -> { value: 5.7, unit: '%' } ; "-0.3" -> { value: -0.3, unit: '' }
 * Boş/eksik değer -> { value: null, unit: '' }
 * App optDouble ile okuyor; string yazılırsa alan sessizce null oluyordu.
 */
function parseValue(raw) {
    if (raw === null || raw === undefined) return { value: null, unit: '' };
    const s = String(raw).trim();
    if (!s) return { value: null, unit: '' };
    const m = s.match(/^(-?[\d.,]+)\s*(.*)$/);
    if (!m) return { value: null, unit: '' };
    const num = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(num)) return { value: null, unit: '' };
    return { value: num, unit: (m[2] || '').trim() };
}

/** ISO (offsetli) -> "yyyy-MM-dd HH:mm:ss" UTC */
function toUtcString(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().replace('T', ' ').slice(0, 19);
}

async function run() {
    console.log('📅 Ekonomik takvim çekiliyor...');
    const feed = await fetchJson(FEED_URL);

    if (!Array.isArray(feed) || feed.length === 0) {
        console.error('❌ Feed alınamadı veya boş — mevcut dosya korunuyor');
        process.exit(1);
    }
    console.log(`  ✅ ${feed.length} kayıt alındı`);

    const events = [];
    for (const row of feed) {
        const event = String(row.title || '').trim();
        const time  = toUtcString(row.date);
        if (!event || !time) continue;

        const est  = parseValue(row.forecast);
        const prev = parseValue(row.previous);
        // actual bu feed'te yok; app null'ı zaten tolere ediyor.
        const act  = parseValue(row.actual);

        events.push({
            country:  String(row.country || '').toUpperCase(),
            event,
            impact:   String(row.impact || 'low').toLowerCase(),
            time,
            actual:   act.value,
            estimate: est.value,
            prev:     prev.value,
            unit:     est.unit || prev.unit || act.unit || '',
        });
    }

    events.sort((a, b) => a.time.localeCompare(b.time));

    const byImpact = events.reduce((acc, e) => {
        acc[e.impact] = (acc[e.impact] || 0) + 1;
        return acc;
    }, {});

    const out = {
        _meta: {
            updated_at: new Date().toISOString(),
            source:     'ForexFactory (nfs.faireconomy.media)',
            count:      events.length,
            range_from: events[0]?.time || '',
            range_to:   events[events.length - 1]?.time || '',
            by_impact:  byImpact,
        },
        economicCalendar: events,
    };

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    // Atomic write: önce .tmp yaz, sonra rename — yarım yazma bozulmasını önler
    const tmp = OUTPUT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
    fs.renameSync(tmp, OUTPUT_FILE);

    console.log(`✅ data/economic-calendar.json kaydedildi (${events.length} olay)`);
    console.log(`   etki dağılımı: ${JSON.stringify(byImpact)}`);
}

run().catch(err => {
    console.error('❌ Beklenmeyen hata:', err.message);
    process.exit(1);
});
