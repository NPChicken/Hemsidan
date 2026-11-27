-- SpinRoll: sending an order finalizes its already-allocated inventory withdrawal.
-- Physical stock was debited when staff selected a warehouse; shipping MUST NOT debit it again.
begin;

alter table public.storefront_stock_reservations
    drop constraint if exists storefront_stock_reservations_status_check;
alter table public.storefront_stock_reservations
    add constraint storefront_stock_reservations_status_check
    check (status in ('reserved','paid','released','fulfilled'));

-- Historical shipped orders may still be marked 'paid' in the reservation table.
-- Reconcile only orders that already had a physical warehouse allocation.
update public.storefront_stock_reservations r
set status = 'fulfilled'
from public.orders o
where o.stripe_checkout_session_id = r.stripe_checkout_session_id
  and o.stripe_mode = 'test'
  and o.fulfillment_status = 'shipped'
  and o.payment_status = 'paid'
  and r.status = 'paid'
  and r.stock_allocated = true;

-- Stripe may deliver checkout.session.completed more than once.
-- A shipped order is already paid, and must stay fulfilled.
create or replace function public.mark_checkout_stock_paid(
    p_reservation_id uuid, p_stripe_session_id text
)
returns void language plpgsql security definer set search_path = ''
as $fn$
declare v_res public.storefront_stock_reservations%rowtype;
begin
    if auth.role() is distinct from 'service_role' then
        raise exception 'Åtkomst nekad' using errcode = '42501';
    end if;
    select * into v_res from public.storefront_stock_reservations
      where id=p_reservation_id for update;
    if not found or v_res.stripe_checkout_session_id is distinct from p_stripe_session_id then
        raise exception 'Betalningssessionen saknar giltig lagerreservation'
            using errcode = '23514';
    end if;
    if v_res.status in ('paid','fulfilled') then return; end if;
    if v_res.status <> 'reserved' then
        raise exception 'Reservationen är redan frigjord' using errcode = '23514';
    end if;
    update public.storefront_stock_reservations
       set status='paid',paid_at=now()
     where id=p_reservation_id;
end;
$fn$;

-- Only allow transitions to new/packing while not shipped.
-- Transition to shipped finalizes the reservation within the same transaction.
create or replace function public.set_order_fulfillment_status(
    p_order_id uuid,p_new_status text,p_expected_status text
)
returns text language plpgsql security definer set search_path = ''
as $fn$
declare
    v_order public.orders%rowtype;
    v_res public.storefront_stock_reservations%rowtype;
    v_result text;
    v_line_total bigint;
begin
    perform public.assert_stock_staff();
    if p_new_status is null or p_new_status not in ('new','packing','shipped')
      or p_expected_status is null or p_expected_status not in ('new','packing','shipped') then
        raise exception 'Ogiltig orderstatus' using errcode='22023';
    end if;

    select * into v_order from public.orders where id=p_order_id for update;
    if not found or v_order.stripe_mode<>'test'
       or v_order.payment_status<>'paid'
       or v_order.fulfillment_status<>p_expected_status then
        raise exception 'Ordern har ändrats. Ladda om och försök igen.'
            using errcode='P0002';
    end if;
    if v_order.fulfillment_status='shipped' and p_new_status<>'shipped' then
        raise exception 'Skickade ordrar kan inte återställas automatiskt'
            using errcode='23514';
    end if;
    if p_new_status='shipped' then
        -- This row is already physically subtracted from an actual warehouse.
        select * into v_res from public.storefront_stock_reservations
          where stripe_checkout_session_id=v_order.stripe_checkout_session_id for update;
        if not found or v_res.status not in ('paid','fulfilled')
           or not v_res.stock_allocated then
            raise exception 'Välj lagerplats för en betald reservation innan ordern skickas'
                using errcode='23514';
        end if;
        select coalesce(sum(quantity),0) into v_line_total
        from public.storefront_stock_reservation_lines
        where reservation_id=v_res.id;
        if v_line_total<>v_res.quantity then
            raise exception 'Reservationsraderna matchar inte ordern'
                using errcode='23514';
        end if;
        -- Finalized, not reserved anymore. No physical stock change here.
        update public.storefront_stock_reservations
          set status='fulfilled'
          where id=v_res.id and status='paid';
    end if;
    update public.orders
       set fulfillment_status=p_new_status,updated_at=now()
     where id=p_order_id and fulfillment_status=p_expected_status
       and stripe_mode='test' and payment_status='paid'
    returning fulfillment_status into v_result;
    if not found then
        raise exception 'Orderstatus kunde inte sparas' using errcode='P0002';
    end if;
    return v_result;
end;
$fn$;

-- Read settled physical warehouse withdrawals as historical, not reserved.
-- The page can therefore show "Uttaget från" on shipped orders.
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
    where o.stripe_mode='test' and o.payment_status='paid'
      and r.status in ('paid','fulfilled');
end;
$fn$;

revoke all on function public.mark_checkout_stock_paid(uuid,text) from public,anon,authenticated;
grant execute on function public.mark_checkout_stock_paid(uuid,text) to service_role;
revoke all on function public.set_order_fulfillment_status(uuid,text,text),
    public.list_paid_order_stock_allocations() from public,anon;
grant execute on function public.set_order_fulfillment_status(uuid,text,text),
    public.list_paid_order_stock_allocations() to authenticated;
commit;
