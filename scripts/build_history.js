/**
 * build_history.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Her saat GitHub Actions tarafından çalıştırılır.
 * data/current.json'daki anlık fiyatları okuyup data/history.json'a ekler.
 *
 * Rollup mantığı (foto 2):
 *   1 saat    → hourly[]  : son 24 giriş tutulur (intraday grafik)
 *   Gece 00:00 → daily[]  : son saatin fiyatı günün kapanışı olur, hourly temizlenir
 *   7 gün dolunca          : 8. gün silinir (rolling 7-day pencere)
 *   Ay sonu    → monthly[]: o günün fiyatı aylık kapanış olur, daily'den çıkarılır
 *   12 ay dolunca          : 13. ay silinir
 *   Yıl sonu   → yearly[] : son monthly fiyatı yıllık kapanış olur
 *   5 yıl dolunca          : 6. yıl silinir
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

const CURRENT_FILE = path.join(__dirname, '..', 'data', 'current.json');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.json');

// ── Zaman yardımcıları (UTC) ──────────────────────────────────────────────────
const now          = new Date();
const utcHour      = now.getUTCHours();
const utcDay       = now.getUTCDate();
const utcMonth     = now.getUTCMonth(); // 0-11
const utcFullYear  = now.getUTCFullYear();

/** Ayın son günü mü? */
function isLastDayOfMonth(d) {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const lastDay = new Date(next - 1).getUTCDate();
    return d.getUTCDate() === lastDay;
}

/** Yılın son günü mü? (31 Aralık) */
function isLastDayOfYear(d) {
    return d.getUTCMonth() === 11 && d.getUTCDate() === 31;
}

/** Günlük kayıt saati: 06:00 UTC (Türkiye 09:00 — piyasalar açılmadan önceki kapanış) */
const isMidnight    = utcHour === 6;
const isMonthEnd    = isMidnight && isLastDayOfMonth(now);
const isYearEnd     = isMidnight && isLastDayOfYear(now);

console.log(`⏰ ${now.toISOString()} | dailyRollup=${isMidnight} | monthEnd=${isMonthEnd} | yearEnd=${isYearEnd}`);

// ── Dosyaları yükle ───────────────────────────────────────────────────────────
let current = {};
try {
    current = JSON.parse(fs.readFileSync(CURRENT_FILE, 'utf8'));
    delete current['_meta'];
} catch (e) {
    console.error('❌ data/current.json okunamadı:', e.message);
    process.exit(1);
}

let history = {};
try {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
} catch {
    console.log('ℹ️ data/history.json bulunamadı, sıfırdan oluşturuluyor');
    history = {};
}

// ── Her varlık için rollup ────────────────────────────────────────────────────
let updatedCount = 0;

Object.entries(current).forEach(([key, asset]) => {
    const price = asset.current;
    if (!price || isNaN(price) || price <= 0) return;

    // history kaydı yoksa oluştur
    if (!history[key]) {
        history[key] = { hourly: [], daily: [], monthly: [], yearly: [] };
    }
    const h = history[key];
    if (!Array.isArray(h.hourly))  h.hourly  = [];
    if (!Array.isArray(h.daily))   h.daily   = [];
    if (!Array.isArray(h.monthly)) h.monthly = [];
    if (!Array.isArray(h.yearly))  h.yearly  = [];

    // ── 1. Her saat: fiyatı hourly'e ekle (max 24) ───────────────────────────
    h.hourly.push(parseFloat(price.toFixed(2)));
    if (h.hourly.length > 24) h.hourly = h.hourly.slice(-24);

    // ── 2. İlk kez oluşturuluyorsa daily'i şimdiki fiyatla seed'le ─────────────
    if (h.daily.length === 0) {
        h.daily.push(parseFloat(price.toFixed(2)));
    }

    // ── 3. Gece yarısı: günün kapanışını daily'e ekle ────────────────────────
    if (isMidnight) {
        // Son hourly fiyatı = günün kapanışı
        const dailyClose = h.hourly.length > 0
            ? h.hourly[h.hourly.length - 1]
            : parseFloat(price.toFixed(2));

        // Ay sonu mu? → monthly'e al
        if (isMonthEnd) {
            h.monthly.push(dailyClose);
            if (h.monthly.length > 60) h.monthly = h.monthly.slice(-60);
            console.log(`  📅 [AY SONU] ${key}: ${dailyClose} → monthly`);

            // Yıl sonu mu? → yearly'e al
            if (isYearEnd) {
                h.yearly.push(dailyClose);
                if (h.yearly.length > 5) h.yearly = h.yearly.slice(-5);
                console.log(`  🗓️  [YIL SONU] ${key}: ${dailyClose} → yearly`);
            }
        }

        // Her gün (ay sonu da dahil) daily'e ekle — son 1825 gün tut (5 yıl)
        h.daily.push(dailyClose);
        if (h.daily.length > 1825) h.daily = h.daily.slice(-1825);

        // Hourly'i temizle (yeni güne sıfırla)
        h.hourly = [];
        console.log(`  🌅 [06:00] ${key}: ${dailyClose} → daily (${h.daily.length}/365)`);
    }

    updatedCount++;
});

// ── Meta bilgisi ──────────────────────────────────────────────────────────────
history['_meta'] = {
    updated_at: now.toISOString(),
    last_midnight: isMidnight ? now.toISOString() : (history['_meta']?.last_midnight || null),
    last_month_end: isMonthEnd ? now.toISOString() : (history['_meta']?.last_month_end || null),
    last_year_end:  isYearEnd  ? now.toISOString() : (history['_meta']?.last_year_end  || null),
};

// ── Kaydet ────────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
const tmpHist = HISTORY_FILE + '.tmp';
fs.writeFileSync(tmpHist, JSON.stringify(history, null, 2), 'utf8');
fs.renameSync(tmpHist, HISTORY_FILE);
console.log(`\n✅ data/history.json kaydedildi (${updatedCount} varlık güncellendi)`);
