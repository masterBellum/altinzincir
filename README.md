# AltınZincir — Veri Deposu

Bu depo, **AltınZincir** Android uygulamasının fiyat verisini üretir ve GitHub Pages
üzerinden yayınlar.

```
GitHub Actions  →  scripts/*.js  →  data/*.json  →  GitHub Pages  →  Android uygulaması
```

> Kökte eskiden bir `index.html` web panosu vardı. Uygulama yazılmadan önce
> "kaynaklar GitHub üzerinden doğru çekiliyor mu" testi için kurulmuştu; işlevi
> bitince 2026-08'de silindi. **Pages hâlâ açık** — sadece kök adres 404 verir,
> `data/` altındaki dosyalar eskisi gibi sunulur (uygulamanın kullandığı yol budur).

---

## Yayınlanan veri

| Dosya | İçerik | Üreten | Sıklık |
|---|---|---|---|
| `data/current.json` | 97 varlık: altın, döviz, kripto | `fetch_current.js` | 5 dk (hedef) |
| `data/history.json` | Rollup biriktirici (hourly/daily/monthly/yearly) | `build_history.js` | 1 saat |
| `data/history/*.json` | Varlık başına grafik serisi (`{key}-{gun\|hafta\|ay\|yil}.json`) | `fetch_current.js` | 1 saat |
| `data/news.json` | 50 haber, kategori kotalı | `fetch_news.js` | 30 dk |

> **Ekonomik takvim burada üretilmiyor.** Uygulama TradingView gömülü widget'ını
> kullanıyor (veri bizde saklanmaz). Eskiden `fetch_calendar.js` + `calendar.yml`
> ikilisi `data/economic-calendar.json` üretiyordu; widget'a geçildikten sonra
> dosyayı okuyan kimse kalmadığı için 2026-08'de üçü de silindi.

---

## Workflow'lar

| Workflow | Tetikleyici | Yazdığı dosya |
|---|---|---|
| `prices.yml` | 5 dk cron (yedek) + `repository_dispatch: fetch-prices` | `data/current.json` |
| `history.yml` | Saatlik + `build-history` | `data/history.json`, `data/history/` |
| `news.yml` | 30 dk + `fetch-news` | `data/news.json` |
| `bootstrap.yml` | Yalnızca manuel | `data/history.json` (tek seferlik dolum) |

**Cron gerçeği:** GitHub scheduled cron'u ağır throttle ediyor — `*/5` ayarlıyken
ölçülen gerçek aralık **~20–57 dakika**. Bu yüzden asıl tetikleme harici bir cron
servisinden `repository_dispatch` ile yapılmalı (test edildi: 20 saniyede tetikliyor).
`schedule` yalnızca yedek olarak duruyor.

**Push çakışması:** Dört workflow da aynı ref'e push ediyor. Her birinde
`pull --rebase --autostash` + `git rebase --abort` + 5 denemeli backoff var.
`rebase --abort` olmadan yarım kalan rebase repoyu kilitliyor ve tüm denemeler
aynı hatayla düşüyordu.

---

## Veri kaynakları ve neden bunlar

| Kaynak | Ne için | Durum |
|---|---|---|
| canlidoviz + Truncgil | Altın (14), gümüş, gram platin | `robots.txt` izinli, halka açık |
| Truncgil → TCMB → fawazahmed0 | Döviz (61) | TCMB resmî kamu verisi; diğerleri serbest |
| CoinGecko | Kripto (20) | Ücretsiz katman, **atıf şartlı** (uygulamada Ayarlar › Veri Kaynakları) |
| Google News RSS | Haberler | Başlık + kaynağa link |

### Neden BIST hissesi ve emtia YOK

`data/current.json` **herkese açık** bir adreste yayınlanıyor; yani veriyi sadece
kullanmıyor, **yeniden dağıtıyoruz**. İncelenen sağlayıcıların tamamı bunu
şartlarında yasaklıyor: Yahoo Finance (resmî olmayan endpoint), Twelve Data,
Finnhub, EODHD, Financial Modeling Prep ve Borsa İstanbul'un kendi veri sözleşmesi.

Bu yüzden:
- **97 BIST hissesi** → önce TradingView gömülü widget'ına taşındı, **2026-08'de
  uygulamadan tamamen kaldırıldı**. Widget veriyi yasal gösteriyordu ama favori ve
  alarm kurulamıyordu; onun için kendi veri hattımız gerekir ve o hattı lisanslamak
  ücretli (aşağıdaki tablo).
- **14 Yahoo emtiası** → Emtia sekmesi kaldırıldı; gümüş ve gram platin Altın
  sekmesine alındı (ikisi de Türk kaynağından, gram cinsinden)

### Yabancı kaynak araştırması (2026-08) — neden hisse geri gelmedi

ABD borsa verisi üç lisans katmanına ayrılıyor: gerçek zamanlı (SIP, ayda beş
haneli), 15 dk gecikmeli (~250 USD/ay UTP) ve **geçmiş / gün sonu — borsa lisansı
gerektirmez, ücretsiz**. Yani borsa tarafı gün sonu veride serbest; duvar
*sağlayıcı sözleşmesi* tarafında:

| Sağlayıcı | Yeniden dağıtım | Not |
|---|---|---|
| Finnhub | Yasak | "…3rd party without written approval"; tüm planlar kişisel kullanım |
| EODHD | Yasak | Profesyonel olmayan kullanıcıya "redistributing, displaying" yasak |
| Alpha Vantage / Twelve Data / Polygon | Ücretli | Ayrı lisans ya da eklenti gerekiyor |
| marketdata.app | Ücretli | Yalnızca "Commercial" planı izin veriyor, özel teklif |
| IEX | Ücretli | Eskiden ücretsizdi; artık TOPS 500 + dağıtım 500 USD/ay |
| **Databento US Equities Mini** | **Serbest** | Tek temiz seçenek: sıfır borsa lisans ücreti + serbest dağıtım, **~200 USD/ay** |

Uygulama ücretsiz ve gelirsiz olduğu için hiçbiri uygun değil. Sonuç: hisse
kategorisi uygulamadan tamamen çıkarıldı (Android tarafında `AssetCategory`).

**Emtia için ise kamu malı kaynaklar var** — ileride gerekirse:

| Kaynak | Lisans | Kapsam | Sıklık |
|---|---|---|---|
| EIA (ABD Enerji Bakanlığı) | Kamu malı, atıf şartlı | WTI, Brent, Henry Hub doğal gaz | **Günlük** |
| Dünya Bankası Pink Sheet | CC BY 4.0 | Metal, tarım, değerli maden, gübre | Aylık |
| USDA (AMS + NASS) | Kamu malı | Tarım nakit fiyatları | Günlük/haftalık |
| IMF Primary Commodity Prices | Atıf şartlı | Genel emtia | Aylık |

- **FRED kullanma:** şartları "yalnızca kişisel, ticari olmayan kullanım" diyor.
  Aynı seriyi doğrudan EIA veya Dünya Bankası'ndan al.
- Metal ve tarımın **günlük vadeli** fiyatları (bakır, kahve, buğday…) hiçbir açık
  kaynakta yok — hepsi CME/ICE/LME borsa verisi, her zaman lisanslı.

Karar: kapsam dar (yalnızca enerji günlük) olduğu için Emtia sekmesi geri
açılmadı; uygulama altın + döviz + kripto olarak sadeleştirildi.

**Tek istisna:** `PL=F` hâlâ Yahoo'dan çekiliyor ama **dosyaya yazılmıyor** —
yalnızca `gram-platin`'in yüzde değişimini hesaplamakta kullanılıyor, çünkü
Truncgil'in `Change` alanı hafta sonu/tatilde bayat kalıyor.

---

## Bilinmesi gereken tasarım kararları

**`SKIP_HISTORY=1`** — `prices.yml` bu bayrakla çalışır. Bayraksız çalıştırma
`data/history/` altında ~962 dosya değiştiriyor; 5 dakikalık kadansta bu günde
~277 bin dosya yazımı demek. Bayrakla fiyat işi yalnızca `current.json` yazar
(1 dosya), run süresi 110 sn → 64 sn düşer. `history.yml` **bilerek bayraksız**
çalışır: `data/history/` üretiminin tek noktası orasıdır.

**`hourlyTs`** — `hourly[]` yalnızca sayı tutuyordu, zaman bilgisi yoktu.
Uygulama noktaların "aralığa eşit dağıldığını" varsayıp grafik tooltip'inde
15 saate varan yanlış saat gösteriyordu. Artık `hourly` ile aynı uzunlukta
epoch-saniye dizisi tutuluyor ve `data/history/*-gun.json` içine `times` olarak
yazılıyor. Eski girişler için `null` konur; yazıcı yalnızca **tüm** damgalar
geçerliyse `times` üretir.

> `hourly` dizisi **gece yarısında değil, 06:00 UTC'de** sıfırlanır
> (`build_history.js`, `isMidnight = utcHour === 6`).

**`_meta.counts` / `stale_assets`** — Bir kaynak çökerse eski değerler korunur
(kasıtlı), ama `updated_at` yine tazelenir. Bu, donmuş fiyatları "az önce
güncellendi" gibi gösteriyordu. Artık kategori bazlı sayaç ve varlık başına `ts`
damgası var; sıfır olan kategori veya 2 saatten eski varlık `_meta.warnings`'e düşer
ve uygulama tazelik göstergesi yerine uyarı gösterir.

**`history.json` minify** — Dosya ~174 bin sayıdan oluşuyor; girintili yazıldığında
boyutun yarısı biçimlendirmeydi. Saatte bir yeniden yazıldığı için repo büyümesine
doğrudan yansıyordu. 2.74 MB → 1.32 MB, kayıpsız.

---

## Kurulum

**Secret'lar:** Yok. (NEWSAPI_KEY kaldırıldı — ücretsiz katmanı yalnızca
geliştirme içindir, üretimde kullanmak lisans ihlali.)

**Harici cron (önerilen):** GitHub cron throttle'ı yüzünden 5 dakikalık kadans için
harici bir zamanlayıcı gerekir:

```
POST https://api.github.com/repos/masterBellum/altinzincir/dispatches
Authorization: Bearer <fine-grained PAT, Contents: read+write>
Accept: application/vnd.github+json
Body: {"event_type":"fetch-prices"}
```

Başarılı yanıt: HTTP 204.
