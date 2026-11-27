-- SpinRoll: exact delivery-batch costs for packed orders.
-- Costs are never inferred from a product-wide average.
begin;

alter table public.storefront_stock_reservations
  add column if not exists selected_delivery_id uuid references public.incoming_stock(id);

create table public.order_delivery_cost_allocations (
  reservation_id uuid primary key references public.storefront_stock_reservations(id),
  order_id uuid not null references public.orders(id),
  delivery_id uuid not null references public.incoming_stock(id),
  item_id uuid not null references public.stock_items(id),
  quantity integer not null check (quantity > 0),
  unit_cost_ore numeric(18,6) not null check (unit_cost_ore >= 0),
  recorded_at timestamptz not null default now()
);
create index order_delivery_cost_allocations_delivery_idx
  on public.order_delivery_cost_allocations(delivery_id);
alter table public.order_delivery_cost_allocations enable row level security;
revoke all on public.order_delivery_cost_allocations from public,anon,authenticated;
grant select on public.order_delivery_cost_allocations to authenticated;
grant all on public.order_delivery_cost_allocations to service_role;
create policy staff_read_order_delivery_cost_allocations
 on public.order_delivery_cost_allocations for select to authenticated
 using (exists(select 1 from public.staff_members sm
   where sm.user_id=(select auth.uid()) and sm.active));

-- Old selection RPC stays in use. A change of warehouse invalidates any
-- previously selected batch, but only if the location really changes.
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
  if not found or v_delivery.status<>'received' or v_delivery.is_test
     or v_delivery.total_cost_ore is null
     or v_delivery.item_id<>v_res.item_id
     or v_delivery.location_id<>v_res.selected_location_id then
    raise exception 'Inköpspartiet måste vara mottaget, äkta, kostnadsfört och på vald plats'
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

create function public.list_order_cost_selections()
returns table(order_id uuid,selected_delivery_id uuid)
language plpgsql stable security definer set search_path = ''
as $fn$
begin
  perform public.assert_stock_staff();
  return query
  select o.id,r.selected_delivery_id from public.orders o
  join public.storefront_stock_reservations r
    on r.stripe_checkout_session_id=o.stripe_checkout_session_id
  where o.stripe_mode='test' and o.payment_status='paid'
    and r.status in ('paid','fulfilled');
end;
$fn$;

-- Snapshot the EXACT unit cost of the chosen delivery on the moment an
-- order is marked packed. If no batch was chosen, its cost stays UNKNOWN;
-- never substitute another delivery's price or 0.
-- Wrapper preserves previous status/stock locks and atomic withdrawal.
alter function public.set_order_fulfillment_status(uuid,text,text)
  rename to set_order_fulfillment_status_stock_core;

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
    if not found or v_delivery.status<>'received' or v_delivery.is_test
       or v_delivery.total_cost_ore is null
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

-- Invalidate the batch choice when warehouse is switched. We store a
-- selected_delivery_id on the reservation, so the batch must match location.
-- The next status wrapper checks location and refuses stale selections.
-- Existing selection RPC permits changing locations; this trigger clears
-- selected batch automatically whenever selected_location_id changes.
create or replace function public.clear_cost_batch_on_location_change()
returns trigger language plpgsql security definer set search_path = ''
as $fn$
begin
  if old.selected_location_id is distinct from new.selected_location_id then
    new.selected_delivery_id:=null;
  end if;
  return new;
end;
$fn$;
create trigger clear_cost_batch_on_location_change
before update of selected_location_id on public.storefront_stock_reservations
for each row execute function public.clear_cost_batch_on_location_change();

-- The dashboard now only reports VERIFIABLE batch-specific margins.
-- Unknown costs are flagged per item and excluded from profitability totals.
create or replace function public.sales_profit_by_product()
returns table(product_name text,sold_quantity bigint,sales_ore bigint,
              known_cost_ore numeric,missing_cost_quantity bigint)
language plpgsql stable security definer set search_path = ''
as $fn$
begin
  perform public.assert_stock_staff();
  return query
  with lines as (
    select oi.product_name,oi.quantity,oi.unit_amount,
      case when (select count(*) from public.order_items x where x.order_id=oi.order_id)=1
                and a.quantity=oi.quantity
          then a.unit_cost_ore else null::numeric end as unit_cost
    from public.orders o
    join public.order_items oi on oi.order_id=o.id
    left join public.order_delivery_cost_allocations a on a.order_id=o.id
    where o.payment_status='paid' and o.stripe_mode='test'
  )
  select lines.product_name,
    sum(lines.quantity)::bigint,
    sum(lines.quantity::bigint*lines.unit_amount::bigint)::bigint,
    coalesce(sum(lines.quantity*lines.unit_cost) filter(where lines.unit_cost is not null),0),
    coalesce(sum(lines.quantity) filter(where lines.unit_cost is null),0)::bigint
  from lines group by lines.product_name
  order by sum(lines.quantity::bigint*lines.unit_amount::bigint) desc,lines.product_name;
end;
$fn$;

revoke all on function public.set_order_fulfillment_status_stock_core(uuid,text,text)
 from public,anon,authenticated;
revoke all on function public.clear_cost_batch_on_location_change()
 from public,anon,authenticated;
revoke all on function public.select_order_cost_delivery(uuid,uuid),
 public.list_order_cost_selections(),
 public.set_order_fulfillment_status(uuid,text,text) from public,anon;
grant execute on function public.select_order_cost_delivery(uuid,uuid),
 public.list_order_cost_selections(),
 public.set_order_fulfillment_status(uuid,text,text) to authenticated;

commit;
