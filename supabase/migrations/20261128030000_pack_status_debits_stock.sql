-- SpinRoll UF: warehouse selection is a PLAN; packing is the physical withdrawal.
-- Requires 20261128010000 and 20261128020000.
begin;

-- A planned warehouse does not belong in reservation_lines (which track
-- physical withdrawals). Keep it separately until packaging is confirmed.
alter table public.storefront_stock_reservations
  add column if not exists selected_location_id uuid
    references public.stock_locations(id);

-- Backfill previously assigned/physically withdrawn orders as historical
-- selections. NEVER debit these a second time when their status is updated.
update public.storefront_stock_reservations r
set selected_location_id = l.location_id
from public.storefront_stock_reservation_lines l
where r.stock_allocated
  and r.selected_location_id is null
  and l.reservation_id=r.id
  and (select count(*) from public.storefront_stock_reservation_lines x
       where x.reservation_id=r.id)=1;

-- Prevent shipment without confirming the physical withdrawal.
-- Keep the stored status 'packing' for schema/filter backward compatibility;
-- the staff UI labels it 'Packad'.
create or replace function public.assign_paid_order_stock_location(
    p_order_id uuid,p_location_id uuid
)
returns void language plpgsql security definer set search_path = ''
as $fn$
declare
    v_order public.orders%rowtype;
    v_res public.storefront_stock_reservations%rowtype;
    v_item uuid;
    v_available integer;
    v_previous jsonb;
begin
    perform public.assert_stock_staff();

    select * into v_order from public.orders where id=p_order_id for update;
    if not found or v_order.stripe_mode <> 'test' or v_order.payment_status <> 'paid'
       or v_order.fulfillment_status <> 'new' then
        raise exception 'Lagerplats kan endast väljas på nya, betalda ordrar'
            using errcode='22023';
    end if;

    -- Look up first, then lock the item consistently with checkout.
    select item_id into v_item from public.storefront_stock_reservations
    where stripe_checkout_session_id=v_order.stripe_checkout_session_id;
    if not found then raise exception 'Ordern saknar reservation' using errcode='23514'; end if;
    perform 1 from public.stock_items where id=v_item and archived_at is null for update;
    if not found then raise exception 'Artikeln är inte aktiv' using errcode='23514'; end if;

    select * into v_res from public.storefront_stock_reservations
    where stripe_checkout_session_id=v_order.stripe_checkout_session_id for update;
    if v_res.status <> 'paid' then
        raise exception 'Reservationen är inte betald' using errcode='23514';
    end if;
    if v_res.stock_allocated then
        -- Legacy orders already had stock deducted by earlier code.
        -- Do not silently move or restore those physical withdrawals here.
        raise exception 'Denna äldre order har redan ett lageruttag. Lagerplatsen kan inte ändras.'
            using errcode='23514';
    end if;
    if not exists (select 1 from public.stock_locations
                   where id=p_location_id and archived_at is null) then
        raise exception 'Lagerplatsen finns inte eller är arkiverad' using errcode='22023';
    end if;
    select quantity into v_available from public.stock_levels
    where item_id=v_item and location_id=p_location_id;
    if coalesce(v_available,0) < v_res.quantity then
        raise exception 'För få fysiska exemplar på vald lagerplats'
            using errcode='23514';
    end if;

    if v_res.selected_location_id is not distinct from p_location_id then return; end if;
    v_previous := case when v_res.selected_location_id is null then '[]'::jsonb
      else jsonb_build_array(jsonb_build_object(
        'location_id',v_res.selected_location_id,'quantity',v_res.quantity)) end;

    -- NO UPDATE on stock_levels or stock_allocated here.
    update public.storefront_stock_reservations
    set selected_location_id=p_location_id where id=v_res.id;

    insert into public.order_stock_location_changes
      (order_id,item_id,from_locations,to_location_id,quantity,changed_by)
    values (p_order_id,v_item,v_previous,p_location_id,v_res.quantity,auth.uid());
end;
$fn$;

create or replace function public.set_order_fulfillment_status(
    p_order_id uuid,p_new_status text,p_expected_status text
)
returns text language plpgsql security definer set search_path = ''
as $fn$
declare
    v_order public.orders%rowtype;
    v_res public.storefront_stock_reservations%rowtype;
    v_item uuid;
    v_old integer;
    v_held bigint;
    v_physical bigint;
    v_line_total bigint;
begin
    perform public.assert_stock_staff();
    if p_new_status is null or p_new_status not in ('new','packing','shipped')
       or p_expected_status is null or p_expected_status not in ('new','packing','shipped') then
        raise exception 'Ogiltig orderstatus' using errcode='22023';
    end if;

    select * into v_order from public.orders where id=p_order_id for update;
    if not found or v_order.stripe_mode<>'test' or v_order.payment_status<>'paid'
       or v_order.fulfillment_status<>p_expected_status then
        raise exception 'Ordern har ändrats. Ladda om och försök igen.' using errcode='P0002';
    end if;
    if p_new_status = p_expected_status then return p_new_status; end if;

    -- The order now has a one-way workflow; never restore shipped/packed
    -- inventory with an ordinary status edit. Returns need a separate process.
    if not (
        (p_expected_status='new' and p_new_status='packing') or
        (p_expected_status='packing' and p_new_status='shipped')
    ) then
        raise exception 'Endast Ny → Packad → Skickad är tillåtet'
            using errcode='22023';
    end if;

    select item_id into v_item from public.storefront_stock_reservations
    where stripe_checkout_session_id=v_order.stripe_checkout_session_id;
    if not found then raise exception 'Ordern saknar lagerreservation' using errcode='23514'; end if;
    -- Same article-level lock as checkout reservation and staff stock edits.
    perform 1 from public.stock_items where id=v_item and archived_at is null for update;
    if not found then raise exception 'Artikeln är arkiverad' using errcode='23514'; end if;

    select * into v_res from public.storefront_stock_reservations
    where stripe_checkout_session_id=v_order.stripe_checkout_session_id for update;
    if v_res.status not in ('paid','fulfilled') then
        raise exception 'Reservationen är inte betald' using errcode='23514';
    end if;

    if p_new_status='packing' then
        if not v_res.stock_allocated then
            if v_res.selected_location_id is null then
                raise exception 'Välj lagerplats innan ordern markeras Packad'
                    using errcode='23514';
            end if;
            if not exists (select 1 from public.stock_locations
                           where id=v_res.selected_location_id and archived_at is null) then
                raise exception 'Vald lagerplats är inte längre aktiv' using errcode='23514';
            end if;
            select quantity into v_old from public.stock_levels
              where item_id=v_item and location_id=v_res.selected_location_id for update;
            if v_old is null or v_old<v_res.quantity then
                raise exception 'Det finns inte tillräckligt många exemplar på vald lagerplats'
                    using errcode='23514';
            end if;
            update public.stock_levels set quantity=v_old-v_res.quantity,updated_at=now()
              where item_id=v_item and location_id=v_res.selected_location_id;

            -- Other customers' pending global holds still need backing stock.
            select coalesce(sum(quantity),0) into v_physical
              from public.stock_levels where item_id=v_item;
            select coalesce(sum(quantity),0) into v_held
              from public.storefront_stock_reservations
              where item_id=v_item and id<>v_res.id
                and (status='reserved' or (status='paid' and not stock_allocated));
            if v_physical < v_held then
                raise exception 'Packningen skulle underskrida andra kunders reservationer'
                    using errcode='23514';
            end if;

            insert into public.storefront_stock_reservation_lines(
                reservation_id,item_id,location_id,quantity
            ) values (v_res.id,v_item,v_res.selected_location_id,v_res.quantity);
            insert into public.stock_events(item_id,location_id,previous_quantity,new_quantity,reason,actor_id)
            values(v_item,v_res.selected_location_id,v_old,v_old-v_res.quantity,
                   'checkout_allocation',auth.uid());
            update public.storefront_stock_reservations
              set stock_allocated=true where id=v_res.id;
        end if;
    elsif p_new_status='shipped' then
        if not v_res.stock_allocated then
            raise exception 'Ordern måste packas och tas från lagret innan den skickas'
                using errcode='23514';
        end if;
        select coalesce(sum(quantity),0) into v_line_total
          from public.storefront_stock_reservation_lines where reservation_id=v_res.id;
        if v_line_total<>v_res.quantity then
            raise exception 'Lageruttaget stämmer inte med orderns antal' using errcode='23514';
        end if;
        update public.storefront_stock_reservations set status='fulfilled'
          where id=v_res.id and status='paid';
    end if;

    update public.orders set fulfillment_status=p_new_status,updated_at=now()
      where id=p_order_id and fulfillment_status=p_expected_status
        and payment_status='paid' and stripe_mode='test';
    if not found then raise exception 'Orderns status kunde inte sparas' using errcode='P0002'; end if;
    return p_new_status;
end;
$fn$;

-- A selected location is shown as a plan until 'packing'; once packed
-- allocations are shown as actual physical withdrawals.
create or replace function public.list_paid_order_stock_allocations()
returns table(order_id uuid,item_id uuid,location_id uuid,quantity integer,allocated boolean)
language plpgsql stable security definer set search_path = ''
as $fn$
begin
    perform public.assert_stock_staff();
    return query
    select o.id,r.item_id,
       case when r.stock_allocated then l.location_id else r.selected_location_id end,
       case when r.stock_allocated then l.quantity else r.quantity end,
       r.stock_allocated
    from public.orders o
    join public.storefront_stock_reservations r
      on r.stripe_checkout_session_id=o.stripe_checkout_session_id
    left join public.storefront_stock_reservation_lines l
      on l.reservation_id=r.id and r.stock_allocated
    where o.stripe_mode='test' and o.payment_status='paid'
      and r.status in ('paid','fulfilled');
end;
$fn$;

-- Protect these server-only and staff-only functions as before.
revoke all on function public.assign_paid_order_stock_location(uuid,uuid),
 public.set_order_fulfillment_status(uuid,text,text),
 public.list_paid_order_stock_allocations() from public,anon;
grant execute on function public.assign_paid_order_stock_location(uuid,uuid),
 public.set_order_fulfillment_status(uuid,text,text),
 public.list_paid_order_stock_allocations() to authenticated;
commit;
