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
4. Under **Planera lagerbeställning** registrerar du artikel, plats dit leveransen ska komma, antal och eventuellt leverantör, datum och anteckning. Det påverkar inte lagersaldot än.
5. När leveransen har kommit fram, klicka på **Markera som mottagen**. Saldot ökar med beställt antal och leveransen försvinner från listan över kommande leveranser. Ett nytt mottagningsförsök av samma leverans nekas.

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
