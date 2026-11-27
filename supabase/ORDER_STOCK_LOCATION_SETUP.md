# Välj lagerplats för betalda webborders

Denna funktion är för Stripe-testordrar i personalpanelen. Kassan reserverar fortfarande
lager automatiskt innan betalning för att förhindra översäljning. Efter betalning
kan personal välja den lagerplats som fysiskt ska leverera ordern.

## Installation

1. Öppna [SQL-migrationen](./migrations/20261128000000_order_stock_location_assignment.sql)
   på branchen `ai/john` och kör **hela filen en gång** i Supabase SQL Editor,
   efter att befintliga lager- och reservationsmigrationer har installerats.
   Migreringen ändrar befintliga lagersaldon **inte**.
2. Publicera `personal.js` och `personal.css` från `ai/john` på webbplatsen,
   tillsammans med uppdaterade `personal.html` om du använder en separat publiceringsprocess.
   Ingen ändring krävs i Cloudflare Workern eller Stripe-webhooken.
3. Ladda om personalsidan med Ctrl+Shift+R.
4. Öppna en **betald testorder** under Senaste beställningarna.
   Här visas nu reserverad lagerplats och en väljare för att byta lagerplats.
5. Välj lagerplats med tillräckligt många lediga exemplar och klicka
   **Spara lagerplats**. Kontrollera saldo på båda lagerplatserna.

## Regler

- Gäller endast betalda testordrar med status **Ny** eller **Packas**.
- En order med flera exemplar måste kunna tas helt från den valda lagerplatsen.
  Blandad plockning kan stödjas senare.
- Alla ändringar sker atomiskt i databasen. Lediga exemplar återförs till
  tidigare lagerplatser och samma antal dras från vald plats.
- Betalda reservationsrader uppdateras så att efterföljande ändringar och historik
  använder den nya platsen. Varje faktisk lagerändring journalförs i
  `stock_events` och valet loggas i `order_stock_location_changes`.
- Order som saknar en betald lagerreservation (till exempel äldre order)
  visar ingen lagerplatsväljare. Lager kan inte flyttas via denna funktion.
- En skickad order kan inte få ändrad lagerplats.

## Testa

- Lägg 3 Exile på lagerplats A och 3 på B.
- Genomför testköp av 2 st. En automatisk reservation drar från lagerplats(er).
- Välj B i orderpanelen, spara, kontrollera att summan A+B är oförändrad
  av bytet och att exakt 2 st är avdragna från B för ordern.
- Testa en plats med för få exemplar: knappen ska inte kunna användas och
  servern ska avvisa ett manipulerat försök.
- Testa att välja samma lager igen (ingen dubbelräkning).
- Markera ordern som skickad: ändring ska spärras även av databasen.

**Viktigt:** Detta är inte kopplat till Stripes skarpa läge. Testa alltid i
testläge innan eventuell produktionssättning.
