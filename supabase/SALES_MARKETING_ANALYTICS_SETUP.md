> **Uppdatering:** Den ursprungliga analysen använde ett vägt produktgenomsnitt för inköpskostnad. Detta har ersatts av **exakt valt inköpsparti per order**, och sociala inlägg kan nu synkroniseras via separata officiella API:er. Följ den aktuella guiden: [DELIVERY_COST_AND_SOCIAL_SYNC_SETUP.md](./DELIVERY_COST_AND_SOCIAL_SYNC_SETUP.md). Texten nedan beskriver den äldre första versionen.

# SpinRoll UF – försäljning, beräknad vinst och köptrender

## Installation på `ai/john`

1. Ta en databasbackup.
2. Kör hela `supabase/migrations/20261128050000_staff_sales_marketing_analytics.sql`
   **en gång** i Supabase SQL Editor (efter befintliga migrationsfiler).
3. Publicera `personal.html`, `personal.js` och `personal.css` från
   `ai/john`. Ingen Cloudflare Worker- eller Stripe webhook-ändring krävs.
4. Logga in på personalsidan och öppna **Försäljning & köptrender**.
5. Registrera ett publicerat inlägg med plattform, rubrik, faktiskt datum/tid
   och eventuell https-länk. Inlägget markeras i tidslinjen.

## Vad siffrorna betyder

- **Försäljning** = summan av orderradernas historiska styckpris × antal
  för registrerade, betalda Stripe-**testordrar**. Betalningsavgifter,
  frakt och skatt ingår inte i beräkningen. Eventuella krediterade
  eller återbetalade orderrader ingår inte.
- **Beräknad bruttovinst** = försäljningen − beräknad varukostnad.
  Det är **inte** bokföringsmässig nettovinst.
- Varukostnaden baseras på **vägt genomsnitt av inköpskostnader** per
  artikel från mottagna leveranser där `total_cost_ore` är ifyllt,
  `status='received'` och `is_test=false`. Styckkostnad från en
  orderrad (`unit_amount`) är ett **försäljningspris**, inte ett inköpspris.
- När kostnad för något sålt exemplar saknas visas **Ej komplett** i
  stället för att räkna okänd kostnad som noll.
- Exakt artikelkoppling finns i nuläget endast för den enkla
  webbkassan med en enda produkt och en matchande lagerreservation.
  Äldre ordrar utan reservation och framtida flerproduktskassor kan därför
  ge okänd kostnad. Det är en medveten säker begränsning.
- Kostnaden är en uppskattning utifrån mottagna partier, inte
  FIFO-partispårning, historiskt styckkostnadspris vid försäljning,
  momsjusterad inköpskostnad eller fullständig bokföring.
- En publicerad marknadsföringspost visas som en datum-markör.
  Sidan antar inte automatiskt att inlägget orsakade köp.
- Tidslinjen är 30, 90 eller 365 dagar. 365 dagar grupperas
  i sjudagarsintervall; mindre perioder visas per dag.
- Nuvarande analys gäller endast registrerade Stripe-testordrar.
  Fysisk direktförsäljning, andra betalningssätt, skarpt Stripe-läge
  och manuella inköp syns **inte** automatiskt.

## Säkerhet

`marketing_posts` använder Supabase RLS. Endast aktiv personal får
läsa. Skriva kan bara aktiva medarbetare via särskilda SQL-funktioner.
En registrerad post kan tas bort av den som skapade den eller en admin.

## Kontrollera

- Registrera testköp med produktpris 249 kr. Summan ska bli 249 kr.
- Lägg till en mottagen verklig leverans av rätt artikel med
  ett totalpris: bruttovinsten ska kunna uppskattas om ordern är
  korrekt kopplad till lagervaran.
- Spara inlägg med datum som ligger inom vald period.
- Kontrollera att markeringen syns på rätt datum.
- Ta bort inlägget och kontrollera att markeringen försvinner.
- Logga ut: analysen ska döljas med personalsidan.

Om data inte laddas: kontrollera SQL-installationen, aktivt personalkonto
och loggen i webbläsarens utvecklarverktyg.
