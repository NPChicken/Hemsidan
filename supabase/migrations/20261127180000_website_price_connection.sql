-- SpinRoll UF: döp den befintliga produktkopplingen "exile" till "website".
-- Denna koppling används för priset på startsidan, Exile-sidan och i kassan.
-- Kräver katalogprismigrationen 20261127170000_catalog_prices.sql.
begin;

do $$
begin
    if exists (
        select 1 from public.catalog_prices
        where storefront_key = 'exile'
    ) and exists (
        select 1 from public.catalog_prices
        where storefront_key = 'website'
    ) then
        raise exception 'Både exile och website används redan. Kontrollera katalogpriserna innan du migrerar.';
    end if;
end;
$$;

update public.catalog_prices
set storefront_key = 'website', updated_at = now()
where storefront_key = 'exile';

commit;
