#!/usr/bin/env bash
# data/current.json'u commit edip push eder.
#
# prices.yml içindeki adımın aynısı; döngü workflow'u (prices-loop.yml) her 5
# dakikada bir bunu çağırdığı için ayrı bir betiğe alındı.
#
# Eşzamanlı push'lara karşı rebase + tekrar deneme var: saatlik history ve
# haber workflow'ları da aynı dala push ediyor, çakışma normal.
set -uo pipefail

git config --global user.name  "AltinZincir-Bot"
git config --global user.email "bot@altinzincir.app"

git add data/current.json
if git diff --cached --quiet; then
    echo "Değişiklik yok"
    exit 0
fi

git commit -m "fiyat: $(date -u '+%H:%M UTC')"

for i in 1 2 3 4 5; do
    if git pull --rebase --autostash origin main && git push; then
        echo "✅ Push başarılı (deneme $i)"
        exit 0
    fi
    # Rebase çakışmada yarım kalırsa depo "unmerged files" durumunda kilitlenir
    # ve sonraki denemeler de aynı hatayla düşer. Temiz duruma dön.
    git rebase --abort 2>/dev/null || true
    echo "⚠️  Push denemesi $i başarısız — yeniden deneniyor"
    sleep $((i * 5))
done

echo "❌ Push 5 denemede de başarısız oldu"
exit 1
