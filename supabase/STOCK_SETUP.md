# Lagerhantering för SpinRolls personalpanel

Denna version hanterar **artiklar**, **lagerplatser**, **antal på varje plats** och **planerade inleveranser**. Allting är på `ai/john` tills ändringarna publicerats. SQL-filen **måste köras i Supabase** innan formulären fungerar.

## Installera

1. Öppna [SQL-filen på GitHub](./migrations/20261127120000_stock_management.sql).
2. Kopiera hela filen.
3. Öppna [Supabase SQL Editor](https://supabase.com/dashboard/project/bevemgjmcdkcbtsxezsa/sql/new) och klistra in koden.
4. Klicka på **Run**. Du ska se `Success. No rows returned`.
5. Slå ihop `ai/john` med webbplatsens publicerade gren (`main`).
6. Öppna `https://spinroll.se/personal.html` och ladda om med Ctrl + Shift + R.

**Kör bara SQL-filen en gång.** Den använder `CREATE TABLE` och `CREATE FUNCTION` utan `IF NOT EXISTS`, så ett andra försök ger fel om den redan installerats.

## Börja använda lagret

1. Skapa först en **artikel**, till exempel `Exile` (enhet `st`).
2. Skapa en **lagerplats**, till exempel `Förråd` eller `Hylla A`. Använd inga privata hemadresser om det inte behövs.
3. Under **Inventera lagersaldo** väljer du artikel, plats och totalt antal som faktiskt finns där. Talet **ersätter** tidigare inventerat antal på just den platsen.
4. Under **Planera lagerbeställning** registrerar du artikel, plats dit leveransen ska komma, antal, **total leveranskostnad i kronor** (valfritt) och eventuellt leverantör, datum och anteckning. Ange hela den planerade inköpskostnaden inklusive eventuell frakt; beloppet sparas i öre för exakta beräkningar. Det påverkar inte lagersaldot än.
5. När leveransen har kommit fram, klicka på **Markera som mottagen**. Saldot ökar med beställt antal och leveransen flyttas till **Tidigare mottagna leveranser**, där kostnaden finns kvar. Ett nytt mottagningsförsök av samma leverans nekas.

## Säkerhet

- Alla fem tabeller har RLS. Bara **aktiv personal** kan läsa lagret.
- All skrivning använder separata `SECURITY DEFINER`-funktioner som kontrollerar personalmedlemskap mot Supabase Auth. Det finns **inga direkta UPDATE/INSERT-rättigheter** för webbläsaren.
- Varje inventering eller mottagning registreras i `stock_events` med föregående och nytt saldo.
- En mottagen leverans kan inte registreras två gånger.
- Leveransbeställningar är interna registerposter, **inte köp som automatiskt beställs hos en leverantör**.
- Lagerantal minskas **inte automatiskt** när en kund köper ett spel i Stripe. Det får vi bygga som ett senare steg när order- och lagerkopplingen är klar.
- Inga riktiga lagerplatser eller artiklar skapas automatiskt genom migrationen.

## Verifiera RLS

Testa både med inloggad personal och en användare utan aktiv `staff_members`-rad. Obehöriga får inte läsa eller skriva poster via API. Testa lagerförändringar med påhittade artiklar innan du använder verkliga saldon.

## Inköpskostnader och framtida vinstberäkning

Varje inleverans har ett valfritt fält `total_cost_ore`. Värdet representerar **den totala kostnaden för just den leveransen**, inte pris per artikel. Fältet kan lämnas tomt om priset inte är känt. Skriv 0 bara när leveransen faktiskt var kostnadsfri. Kostnaden sparas även när leveransen tas emot.

Panelen visar **Planerade inköp** och **Mottagna inköp**, beräknade på upp till de 200 senaste inleveransposterna som klienten hämtar. De är inte ännu en fullständig ekonomisk rapport. Belopp för leveranser utan angiven kostnad kan inte räknas med.

**Detta är inte vinst:** För att korrekt visa bruttovinst framöver behöver vi koppla sålda exemplar till inköpskostnad, skilja på betalda/mottagna leveranser, hantera moms, frakt och avgifter samt se till att även äldre ordrar/leveranser ingår.

Om SQL-filen ännu inte har körts i Supabase, kopiera och kör dess **senaste version** som inkluderar `total_cost_ore`. Om du redan hann köra en tidigare version av lager-SQL, kör inte hela filen igen; meddela det så kan vi lägga en separat ändringsmigration för den befintliga databasen.

## Lagerplatslista och borttagning (nytt)

Det finns en egen ruta **Lagerplatser** där alla aktiva platser och deras beskrivningar visas. Artiklar har knappen **Ta bort artikel**, och lagerplatser har knappen **Ta bort lagerplats**.

För att aktivera funktionen behöver du köra [`20261127150000_archive_stock.sql`](./migrations/20261127150000_archive_stock.sql) **efter att lagerdatabasen skapats**. Den lägger till kolumnen `archived_at` och funktionerna `archive_stock_item` samt `archive_stock_location`. Kör den via Supabase SQL Editor en gång, och publicera sedan de nya `personal.html`, `personal.js` och `personal.css`.

Borttagning är en **arkivering**: artikeln eller platsen försvinner från aktiva listor och formulär, men tidigare inleveranser, revisionsloggar och inköpskostnader ligger kvar i databasen för framtida ekonomiska rapporter. Detta förhindrar att historiska kopplingar förstörs. Funktionen vägrar arkivering om det finns saldo kvar på platsen eller artikeln, eller någon planerad leverans som använder den. Inventera till noll och hantera alla väntande leveranser först. Skyddet kontrolleras på serversidan med Supabase Auth och inte bara av gränssnittet.

Koden stöder för närvarande inte att återaktivera en arkiverad artikel eller plats i panelen; det får vi lägga till separat vid behov.
