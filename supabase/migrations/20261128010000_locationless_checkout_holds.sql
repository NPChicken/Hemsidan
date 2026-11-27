-- SpinRoll: no warehouse is debited until staff assigns a PAID order.
-- Run once after 20261128000000_order_stock_location_assignment.sql.
-- Schedule a short checkout maintenance window before running this migration.
begin;

-- Prevent concurrent legacy checkouts, manual stock edits and webhook updates
-- while restoring stock that old checkout sessions deducted.
lock table public.stock_items, public.stock_levels,
    public.storefront_stock_reservations,
    public.storefront_stock_reservation_lines,
    public.orders in access exclusive mode;

alter table public.storefront_stock_reservations
    add column stock_allocated boolean not null default false;

-- Previously selected warehouses and shipped orders have already consumed stock.
-- Retain their recorded withdrawals; unassigned orders must instead become holds.
update public.storefront_stock_reservations r
set stock_allocated = true
where r.status = 'paid'
  and exists (
      select 1 from public.orders o
      where o.stripe_checkout_session_id = r.stripe_checkout_session_id
        and (o.fulfillment_status = 'shipped' or exists (
            select 1 from public.order_stock_location_changes h where h.order_id=o.id
        ))
  );

-- Old reservations used to reduce physical stock immediately.
-- Verify all balances BEFORE restoring anything, so this migration is atomic.
do $$
declare v_bad integer;
begin
    select count(*) into v_bad
    from (
        select l.item_id,l.location_id,sum(l.quantity)::bigint qty
        from public.storefront_stock_reservation_lines l
        join public.storefront_stock_reservations r on r.id=l.reservation_id
        where r.status in ('reserved','paid') and not r.stock_allocated
        group by l.item_id,l.location_id
    ) t
    left join public.stock_levels sl
      on sl.item_id=t.item_id and sl.location_id=t.location_id
    where sl.item_id is null or sl.quantity + t.qty > 1000000;
    if v_bad > 0 then
        raise exception 'Kunde inte återställa gamla reservationer: lagersaldo saknas eller blir för stort';
    end if;
end $$;

with returned as (
    select l.item_id,l.location_id,sum(l.quantity)::integer qty
    from public.storefront_stock_reservation_lines l
    join public.storefront_stock_reservations r on r.id=l.reservation_id
    where r.status in ('reserved','paid') and not r.stock_allocated
    group by l.item_id,l.location_id
)
update public.stock_levels sl
set quantity=sl.quantity+returned.qty,updated_at=now()
from returned
where sl.item_id=returned.item_id and sl.location_id=returned.location_id;

-- Old stock_events are historical and are not removed.
-- A new event reason records each accounting migration restoration.
alter table public.stock_events drop constraint if exists stock_events_reason_check;
alter table public.stock_events add constraint stock_events_reason_check
check(reason in ('manual_count','delivery','delivery_reversal',
                'checkout_reservation','checkout_release','checkout_reassignment',
                'checkout_migration_restore','checkout_allocation'));

-- Create an audit entry for each restored reservation line (the old entry is
-- already journalled). This is a migration-specific accounting correction.
-- We cannot derive intermediate balances from a batched restore; snapshots
-- reflect the final balance while keeping the corrected quantity audit.
insert into public.stock_events(item_id,location_id,previous_quantity,new_quantity,reason,actor_id)
select t.item_id,t.location_id,
       sl.quantity - t.qty, sl.quantity,
       'checkout_migration_restore',null
from (
    select l.item_id,l.location_id,sum(l.quantity)::integer qty
    from public.storefront_stock_reservation_lines l
    join public.storefront_stock_reservations r on r.id=l.reservation_id
    where r.status in ('reserved','paid') and not r.stock_allocated
    group by l.item_id,l.location_id
) t
join public.stock_levels sl on sl.item_id=t.item_id and sl.location_id=t.location_id;

delete from public.storefront_stock_reservation_lines l
using public.storefront_stock_reservations r
where l.reservation_id=r.id and not r.stock_allocated;

-- A reserved or paid-but-unallocated order is an abstract hold, not inventory
-- at any warehouse. Physical stock remains unchanged until staff allocation.
create or replace function public.public_storefront_stock()
returns table (storefront_key text, available_quantity bigint)
language sql stable security definer set search_path = ''
as $fn$
    select cp.storefront_key,
       greatest(0, coalesce((
           select sum(sl.quantity)::bigint from public.stock_levels sl
           where sl.item_id = cp.item_id
       ),0) - coalesce((
           select sum(r.quantity)::bigint from public.storefront_stock_reservations r
           where r.item_id=cp.item_id
             and (r.status='reserved' or (r.status='paid' and not r.stock_allocated))
       ),0)) as available_quantity
    from public.catalog_prices cp
    join public.stock_items si on si.id=cp.item_id and si.archived_at is null
    where cp.storefront_key is not null;
$fn$;

create or replace function public.reserve_storefront_stock(
    p_storefront_key text,p_quantity integer
)
returns uuid language plpgsql security definer set search_path = ''
as $fn$
declare v_item uuid; v_physical bigint; v_held bigint; v_id uuid;
begin
    if auth.role() is distinct from 'service_role' then
        raise exception 'Åtkomst nekad' using errcode='42501';
    end if;
    if p_quantity is null or p_quantity not between 1 and 10 then
        raise exception 'Ogiltigt antal' using errcode='22023';
    end if;
    select si.id into v_item
    from public.catalog_prices cp
    join public.stock_items si on si.id=cp.item_id
    where cp.storefront_key=p_storefront_key and si.archived_at is null
    for update of si;
    if not found then raise exception 'Produkten säljs inte i butiken' using errcode='22023'; end if;
    select coalesce(sum(quantity),0) into v_physical
      from public.stock_levels where item_id=v_item;
    select coalesce(sum(quantity),0) into v_held
      from public.storefront_stock_reservations
      where item_id=v_item and (status='reserved' or (status='paid' and not stock_allocated));
    if v_physical - v_held < p_quantity then
        raise exception 'Inte tillräckligt många exemplar kvar i lager' using errcode='23514';
    end if;
    insert into public.storefront_stock_reservations(item_id,quantity)
      values(v_item,p_quantity) returning id into v_id;
    return v_id;
end;
$fn$;

-- Existing stripe-session bind and mark-paid functions are unchanged.
-- Releasing a hold must NOT adjust stock_levels.
create or replace function public.release_checkout_stock_reservation(
    p_reservation_id uuid,p_stripe_session_id text default null
)
returns void language plpgsql security definer set search_path = ''
as $fn$
declare v_res public.storefront_stock_reservations%rowtype;
begin
    if auth.role() is distinct from 'service_role' then
        raise exception 'Åtkomst nekad' using errcode='42501';
    end if;
    select * into v_res from public.storefront_stock_reservations
      where id=p_reservation_id for update;
    if not found then raise exception 'Reservationen saknas' using errcode='P0002'; end if;
    if p_stripe_session_id is not null and
       v_res.stripe_checkout_session_id is distinct from p_stripe_session_id then
        raise exception 'Fel Stripe-session' using errcode='23514';
    end if;
    if v_res.status='released' then return; end if;
    if v_res.status<>'reserved' or v_res.stock_allocated then
        raise exception 'Betald eller allokerad reservation kan inte släppas' using errcode='23514';
    end if;
    update public.storefront_stock_reservations
    set status='released',released_at=now() where id=p_reservation_id;
end;
$fn$;

-- Function result type changes from the previous migration: replace its signature.
drop function public.list_paid_order_stock_allocations();

-- One aggregate row per order: allocated=false and location=null until staff
-- explicitly chooses a warehouse. Historical multi-location shipments remain.
create or replace function public.list_paid_order_stock_allocations()
returns table(order_id uuid,item_id uuid,location_id uuid,quantity integer,allocated boolean)
language plpgsql stable security definer set search_path = ''
as $fn$
begin
    perform public.assert_stock_staff();
    return query
    select o.id,r.item_id,
       case when r.stock_allocated then l.location_id else null::uuid end,
       case when r.stock_allocated then l.quantity else r.quantity end,
       r.stock_allocated
    from public.orders o
    join public.storefront_stock_reservations r
      on r.stripe_checkout_session_id=o.stripe_checkout_session_id
    left join public.storefront_stock_reservation_lines l
      on l.reservation_id=r.id and r.stock_allocated
    where o.stripe_mode='test' and o.payment_status='paid' and r.status='paid';
end;
$fn$;

create or replace function public.assign_paid_order_stock_location(
    p_order_id uuid,p_location_id uuid
)
returns void language plpgsql security definer set search_path = ''
as $fn$
declare
    v_order public.orders%rowtype;
    v_res public.storefront_stock_reservations%rowtype;
    v_item uuid;
    v_old_loc record;
    v_old_qty integer;
    v_new_qty integer;
    v_held bigint;
    v_physical bigint;
    v_previous jsonb;
begin
    perform public.assert_stock_staff();
    select * into v_order from public.orders where id=p_order_id for update;
    if not found or v_order.stripe_mode<>'test' or v_order.payment_status<>'paid'
       or v_order.fulfillment_status not in ('new','packing') then
        raise exception 'Endast betalda, ej skickade testordrar kan ändras' using errcode='22023';
    end if;

    -- Find item before locking; all other stock operations lock this item first.
    select r.item_id into v_item from public.storefront_stock_reservations r
      where r.stripe_checkout_session_id=v_order.stripe_checkout_session_id;
    if not found then
        raise exception 'Ordern saknar lagerreservation' using errcode='23514';
    end if;
    perform 1 from public.stock_items
      where id=v_item and archived_at is null for update;
    if not found then raise exception 'Artikeln saknas' using errcode='23514'; end if;
    select * into v_res from public.storefront_stock_reservations
      where stripe_checkout_session_id=v_order.stripe_checkout_session_id for update;
    if v_res.status <> 'paid' then
        raise exception 'Orderns reservation är ännu inte betald' using errcode='23514';
    end if;
    if not exists (select 1 from public.stock_locations
                   where id=p_location_id and archived_at is null) then
        raise exception 'Lagerplatsen saknas' using errcode='22023';
    end if;
    if v_res.stock_allocated and (
        select count(*)=1 and bool_and(location_id=p_location_id)
        from public.storefront_stock_reservation_lines
        where reservation_id=v_res.id
    ) then return; end if;

    select coalesce(jsonb_agg(jsonb_build_object('location_id',l.location_id,
      'quantity',l.quantity)), '[]'::jsonb)
    into v_previous from public.storefront_stock_reservation_lines l
    where l.reservation_id=v_res.id;

    -- Restore previous physical stock debits, if any, then debit chosen location.
    -- One DB transaction means other checkouts cannot observe intermediate values.
    for v_old_loc in
        select location_id, quantity from public.storefront_stock_reservation_lines
        where reservation_id=v_res.id order by location_id
    loop
        select quantity into v_old_qty from public.stock_levels
          where item_id=v_item and location_id=v_old_loc.location_id for update;
        if v_old_qty is null or v_old_qty+v_old_loc.quantity>1000000 then
            raise exception 'Kunde inte återställa tidigare lageruttag' using errcode='23514';
        end if;
        update public.stock_levels set quantity=v_old_qty+v_old_loc.quantity,updated_at=now()
          where item_id=v_item and location_id=v_old_loc.location_id;
        insert into public.stock_events(item_id,location_id,previous_quantity,new_quantity,reason,actor_id)
          values(v_item,v_old_loc.location_id,v_old_qty,v_old_qty+v_old_loc.quantity,
                'checkout_reassignment',auth.uid());
    end loop;

    select quantity into v_old_qty from public.stock_levels
      where item_id=v_item and location_id=p_location_id for update;
    if v_old_qty is null or v_old_qty<v_res.quantity then
        raise exception 'För få exemplar på vald lagerplats' using errcode='23514';
    end if;
    v_new_qty := v_old_qty-v_res.quantity;
    update public.stock_levels set quantity=v_new_qty,updated_at=now()
      where item_id=v_item and location_id=p_location_id;
    insert into public.stock_events(item_id,location_id,previous_quantity,new_quantity,reason,actor_id)
      values(v_item,p_location_id,v_old_qty,v_new_qty,'checkout_allocation',auth.uid());

    -- The user's choice consumes this order's hold, but other orders' holds
    -- must still be backed by the remaining physical inventory.
    select coalesce(sum(quantity),0) into v_physical
      from public.stock_levels where item_id=v_item;
    select coalesce(sum(quantity),0) into v_held
      from public.storefront_stock_reservations
      where item_id=v_item and id<>v_res.id
        and (status='reserved' or (status='paid' and not stock_allocated));
    if v_physical<v_held then
        raise exception 'Valet skulle minska lagret under andra kunders reservationer'
            using errcode='23514';
    end if;

    delete from public.storefront_stock_reservation_lines where reservation_id=v_res.id;
    insert into public.storefront_stock_reservation_lines(reservation_id,item_id,location_id,quantity)
      values(v_res.id,v_item,p_location_id,v_res.quantity);
    update public.storefront_stock_reservations set stock_allocated=true where id=v_res.id;
    insert into public.order_stock_location_changes
      (order_id,item_id,from_locations,to_location_id,quantity,changed_by)
    values(p_order_id,v_item,v_previous,p_location_id,v_res.quantity,auth.uid());
end;
$fn$;

-- Enforce that an order cannot be shipped before staff chooses a physical
-- warehouse. This also prevents bypass by making a direct status RPC call.
create or replace function public.set_order_fulfillment_status(
    p_order_id uuid,p_new_status text,p_expected_status text
)
returns text language plpgsql security definer set search_path = ''
as $fn$
declare v_status text; v_session text;
begin
    perform public.assert_stock_staff();
    if p_new_status is null or p_new_status not in ('new','packing','shipped')
      or p_expected_status is null or p_expected_status not in ('new','packing','shipped') then
        raise exception 'Ogiltig orderstatus' using errcode='22023';
    end if;
    select stripe_checkout_session_id into v_session
    from public.orders where id=p_order_id and stripe_mode='test'
       and payment_status='paid' for update;
    if not found then raise exception 'Ordern saknas' using errcode='P0002'; end if;
    if p_new_status='shipped' and exists (
        select 1 from public.storefront_stock_reservations r
        where r.stripe_checkout_session_id=v_session
          and (r.status<>'paid' or not r.stock_allocated)
    ) then
        raise exception 'Välj lagerplats innan ordern kan skickas' using errcode='23514';
    end if;
    update public.orders
    set fulfillment_status=p_new_status,updated_at=now()
    where id=p_order_id and fulfillment_status=p_expected_status
       and stripe_mode='test' and payment_status='paid'
    returning fulfillment_status into v_status;
    if not found then raise exception 'Ordern har ändrats. Ladda om och försök igen.' using errcode='P0002'; end if;
    return v_status;
end;
$fn$;

-- Stop changing already-committed inventory while orders are pending.
-- Stock reductions cannot silently consume another customer's global hold.
create or replace function public.enforce_unallocated_stock_holds()
returns trigger language plpgsql security definer set search_path = ''
as $fn$
declare v_held bigint; v_physical bigint;
begin
    if tg_op='DELETE' then
        raise exception 'Ta inte bort lagerrader direkt' using errcode='23514';
    end if;
    -- In a transaction already holding a stock_items row lock, the check
    -- serializes checkout reservations and staff stock updates.
    select coalesce(sum(quantity),0) into v_physical
      from public.stock_levels where item_id=new.item_id;
    select coalesce(sum(quantity),0) into v_held
      from public.storefront_stock_reservations
      where item_id=new.item_id
      and (status='reserved' or (status='paid' and not stock_allocated));
    if v_physical<v_held then
        raise exception 'Ändringen skulle underskrida reserverat totalantal'
            using errcode='23514';
    end if;
    return null;
end;
$fn$;

-- Only validate final state for each row-changing statement; callers still
-- need to serialize on stock_items for concurrent adjustments.
drop trigger if exists enforce_stock_holds_update on public.stock_levels;
create constraint trigger enforce_stock_holds_update
after insert or update on public.stock_levels
deferrable initially deferred
for each row execute function public.enforce_unallocated_stock_holds();

-- Record and protect unallocated reservations when removing a location.
-- A location may have zero quantity while abstract holds still exist.
-- Existing archive RPC's stock-item safety is retained.

revoke all on function public.public_storefront_stock() from public,authenticated;
grant execute on function public.public_storefront_stock() to anon,authenticated;
revoke all on function public.reserve_storefront_stock(text,integer),
 public.release_checkout_stock_reservation(uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_storefront_stock(text,integer),
 public.release_checkout_stock_reservation(uuid,text) to service_role;
revoke all on function public.list_paid_order_stock_allocations(),
 public.assign_paid_order_stock_location(uuid,uuid) from public,anon;
grant execute on function public.list_paid_order_stock_allocations(),
 public.assign_paid_order_stock_location(uuid,uuid) to authenticated;
revoke all on function public.enforce_unallocated_stock_holds() from public,anon,authenticated;
commit;
