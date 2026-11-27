# SpinRoll – fysiskt lager dras först vid Packad

## Installera (på ai/john)

1. Ta backup av Supabase och pausa nya testköp medan migrationen körs.
2. Installera tidigare migrationer till och med
   `20261128020000_complete_shipped_stock_reservations.sql`.
3. Kör **hela** `supabase/migrations/20261128030000_pack_status_debits_stock.sql`
   **en gång** i Supabase SQL Editor.
4. Publicera `personal.js` **och** `personal.html` från `ai/john`.
5. Gör hård omladdning (Ctrl+Shift+R) och använd nya testordrar.

Kassan, Stripe-webhooken, Cloudflare Worker och `butikslager.js` använder
samma reservationsfunktioner som tidigare och behöver inte ändras.

## Nytt flöde

- **Ny betald order:** global reservation (fysiska lagerplatser oförändrade).
- **Välj lagerplats:** sparar en planerad plockplats; **INGET** fysiskt uttag.
  Den centrala spärren finns kvar.
- **Packad** (databasvärde `packing`): servern kontrollerar platsen,
  drar exakt beställt antal, omvandlar central reservation till ett
  bokfört lageruttag och uppdaterar orderstatus i **samma databastransaktion**.
  Andra reserverade ordrar får inte bli utan täckning.
- **Skickad:** reservationen får status `fulfilled` utan fler lageravdrag.
- Ordningen är strikt **Ny → Packad → Skickad**. Man kan inte backa en
  packad/skickad order genom en vanlig statusändring.

**Exempel:** Lager A=5, Lager B=5, reserverade=0, tillgängliga=10.
Kund betalar 2: A=5, B=5, reserverade=2, tillgängliga=8.
Personal väljer A: värdena är oförändrade.
Personal sätter Packad: A=3, B=5, reserverade=0, tillgängliga=8.
Personal sätter Skickad: oförändrat lager och inga reservationer.

## Befintliga order (viktig skillnad)

Tidigare version drog varor redan när en plats valdes.
För äldre order med `stock_allocated=true` behålls det tidigare,
redan gjorda fysiska uttaget. Om ordern fortfarande är **Ny**,
kommer övergången till **Packad** INTE dra varan igen.
En redan Packad/Skickad order behåller sitt tidigare lageruttag.
Migrationen återställer inte gamla uttag automatiskt, eftersom detta
kan förstöra faktisk inventering om ordern redan packats fysiskt.

Välj en **ny** testorder för att verifiera det nya flödet.

## Felsökning

Om Packad nekas: kontrollera att en lagerplats är vald, att tillräckligt
fysiskt saldo finns just på platsen och att det totala saldot kan täcka
andra reservationer. Ingen delvis dragning sker vid ett fel.
