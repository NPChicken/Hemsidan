-- Stripe TEST orders may use received test deliveries for test profit calculations.
-- Does not change physical stock, existing orders or real deliveries.
-- Works after 20261128060000_order_delivery_batch_costs.sql.
begin;

create or replace function public.select_order_cost_delivery(
    p_order_id uuid,p_delivery_id uuid
)
returns void language plpgsql security definer set search_path = ''
as $fn$
declare v_order public.orders%rowtype;
        v_res public.storefront_stock_reservations%rowtype;
        v_delivery public.incoming_stock%rowtype;
        v_consumed bigint;
begin
  perform public.assert_stock_staff();
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.stripe_mode<>'test' or v_order.payment_status<>'paid'
     or v_order.fulfillment_status<>'new' then
    raise exception 'Endast nya betalda ordrar kan välja inköpsparti' using errcode='22023';
  end if;
  select * into v_res from public.storefront_stock_reservations
    where stripe_checkout_session_id=v_order.stripe_checkout_session_id for update;
  if not found or v_res.status<>'paid' or v_res.stock_allocated
     or v_res.selected_location_id is null then
    raise exception 'Välj först lagerplats för den nya ordern' using errcode='23514';
  end if;
  -- Lock the delivery against another assignment and pack operation.
  select * into v_delivery from public.incoming_stock
    where id=p_delivery_id for update;
  if not found or v_delivery.status<>'received'      or v_delivery.total_cost_ore is null
     or v_delivery.item_id<>v_res.item_id
     or v_delivery.location_id<>v_res.selected_location_id then
    raise exception 'Inköpspartiet måste vara mottaget och kostnadsfört och på vald plats'
      using errcode='23514';
  end if;
  select coalesce(sum(quantity),0) into v_consumed
    from public.order_delivery_cost_allocations where delivery_id=p_delivery_id;
  if v_delivery.quantity-v_consumed<v_res.quantity then
    raise exception 'Det finns inte tillräckligt många ej bokförda exemplar i detta inköpsparti'
       using errcode='23514';
  end if;
  update public.storefront_stock_reservations
  set selected_delivery_id=p_delivery_id where id=v_res.id;
end;
$fn$;

create function public.set_order_fulfillment_status(
    p_order_id uuid,p_new_status text,p_expected_status text
)
returns text language plpgsql security definer set search_path = ''
as $fn$
declare v_order public.orders%rowtype;
        v_res public.storefront_stock_reservations%rowtype;
        v_delivery public.incoming_stock%rowtype;
        v_consumed bigint;
        v_result text;
begin
  perform public.assert_stock_staff();
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Ordern saknas' using errcode='P0002'; end if;
  select * into v_res from public.storefront_stock_reservations
    where stripe_checkout_session_id=v_order.stripe_checkout_session_id for update;
  if not found then raise exception 'Reservationen saknas' using errcode='23514'; end if;
  if p_new_status='packing' and p_expected_status='new'
     and not v_res.stock_allocated and v_res.selected_delivery_id is not null then
    select * into v_delivery from public.incoming_stock
      where id=v_res.selected_delivery_id for update;
    if not found or v_delivery.status<>'received'        or v_delivery.total_cost_ore is null
       or v_delivery.item_id<>v_res.item_id
       or v_delivery.location_id<>v_res.selected_location_id then
      raise exception 'Valt inköpsparti är inte längre giltigt' using errcode='23514';
    end if;
    select coalesce(sum(quantity),0) into v_consumed
      from public.order_delivery_cost_allocations where delivery_id=v_delivery.id;
    if v_delivery.quantity-v_consumed<v_res.quantity then
       raise exception 'Inköpspartiets resterande antal räcker inte till ordern'
         using errcode='23514';
    end if;
  end if;
  v_result:=public.set_order_fulfillment_status_stock_core(
    p_order_id,p_new_status,p_expected_status);
  if p_new_status='packing' and p_expected_status='new'
     and not v_res.stock_allocated and v_res.selected_delivery_id is not null then
    insert into public.order_delivery_cost_allocations(
      reservation_id,order_id,delivery_id,item_id,quantity,unit_cost_ore)
    values(v_res.id,p_order_id,v_delivery.id,v_res.item_id,v_res.quantity,
        v_delivery.total_cost_ore::numeric/v_delivery.quantity);
  end if;
  return v_result;
end;
$fn$;

commit;
