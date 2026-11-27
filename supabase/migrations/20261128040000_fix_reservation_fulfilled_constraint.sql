-- Repair a checkout reservation status constraint left on the old 3-state definition.
-- Safe to run after 20261128020000 and 20261128030000.
-- Does not modify orders, stock levels, or reservation rows.
begin;

alter table public.storefront_stock_reservations
    drop constraint if exists storefront_stock_reservations_status_check;

alter table public.storefront_stock_reservations
    add constraint storefront_stock_reservations_status_check
    check (status in ('reserved', 'paid', 'released', 'fulfilled'));

-- Check the new rule exists, without touching any reserved quantities.
do $check$
declare v_definition text;
begin
    select pg_get_constraintdef(c.oid) into v_definition
      from pg_constraint c
      where c.conrelid = 'public.storefront_stock_reservations'::regclass
        and c.conname = 'storefront_stock_reservations_status_check';
    if v_definition is null or position('fulfilled' in v_definition)=0 then
        raise exception 'Reservation status constraint repair did not apply';
    end if;
end;
$check$;

commit;
