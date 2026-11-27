-- Reassign the physical stock source of a PAID Stripe test order.
-- Keep the original stock reservation record as source of truth for order quantities.
-- Staff-only functions, all changes serialized and journaled within one transaction.
begin;

alter table public.stock_events drop constraint if exists stock_events_reason_check;
alter table public.stock_events add constraint stock_events_reason_check
    check (reason in (
        'manual_count','delivery','delivery_reversal',
        'checkout_reservation','checkout_release','checkout_reassignment'
    ));

create table public.order_stock_location_changes (
    id bigint generated always as identity primary key,
    order_id uuid not null references public.orders(id),
    item_id uuid not null references public.stock_items(id),
    from_locations jsonb not null,
    to_location_id uuid not null references public.stock_locations(id),
    quantity integer not null check (quantity > 0),
    changed_by uuid references auth.users(id) on delete set null,
    changed_at timestamptz not null default now()
);
create index order_stock_location_changes_order_idx
    on public.order_stock_location_changes (order_id, changed_at desc);
alter table public.order_stock_location_changes enable row level security;
revoke all on public.order_stock_location_changes from public, anon, authenticated;
grant select on public.order_stock_location_changes to authenticated;
grant all on public.order_stock_location_changes to service_role;
create policy staff_read_stock_location_changes
on public.order_stock_location_changes for select to authenticated
using (exists (
    select 1 from public.staff_members sm
    where sm.user_id = (select auth.uid()) and sm.active
));

-- For the staff page: allocations for paid test orders only.
create function public.list_paid_order_stock_allocations()
returns table(order_id uuid, item_id uuid, location_id uuid, quantity integer)
language plpgsql stable security definer set search_path = ''
as $fn$
begin
    perform public.assert_stock_staff();
    return query
    select o.id, r.item_id, l.location_id, l.quantity
    from public.orders o
    join public.storefront_stock_reservations r
      on r.stripe_checkout_session_id = o.stripe_checkout_session_id
    join public.storefront_stock_reservation_lines l on l.reservation_id = r.id
    where o.stripe_mode = 'test' and o.payment_status = 'paid'
      and r.status = 'paid';
end;
$fn$;

-- Move an order's already-reserved stock to exactly one chosen location.
-- IMPORTANT: No total stock change; stock at former locations is restored.
-- Lock order/reservation and item before checking quantities, preventing concurrent
-- moves, Stripe release, and concurrent checkout reservations from over-selling.
create function public.assign_paid_order_stock_location(
    p_order_id uuid, p_location_id uuid
)
returns void language plpgsql security definer set search_path = ''
as $fn$
declare
    v_order public.orders%rowtype;
    v_res public.storefront_stock_reservations%rowtype;
    v_loc public.stock_locations%rowtype;
    v_available integer;
    v_allocated integer;
    v_total integer;
    v_existing integer;
    v_old integer;
    v_new integer;
    v_delta integer;
    v_line record;
    v_previous jsonb;
begin
    perform public.assert_stock_staff();
    select * into v_order from public.orders
      where id = p_order_id for update;
    if not found or v_order.stripe_mode <> 'test' or
       v_order.payment_status <> 'paid' or
       v_order.fulfillment_status not in ('new','packing') then
        raise exception 'Endast betalda, ej skickade testordrar kan ändras'
           using errcode = '22023';
    end if;

    select * into v_res from public.storefront_stock_reservations
    where stripe_checkout_session_id = v_order.stripe_checkout_session_id for update;
    if not found or v_res.status <> 'paid' then
        raise exception 'Ordern saknar bekräftad lagerreservation'
          using errcode = '23514';
    end if;

    -- Match the locking order used by existing checkout stock RPCs.
    perform 1 from public.stock_items
    where id = v_res.item_id and archived_at is null for update;
    if not found then raise exception 'Artikeln är arkiverad' using errcode='23514'; end if;

    select * into v_loc from public.stock_locations
    where id = p_location_id and archived_at is null;
    if not found then raise exception 'Lagerplatsen finns inte eller är arkiverad' using errcode='22023'; end if;

    select coalesce(sum(quantity),0)::integer,
           coalesce(sum(quantity) filter (where location_id=p_location_id),0)::integer
    into v_total, v_existing
    from public.storefront_stock_reservation_lines
    where reservation_id = v_res.id;
    if v_total <> v_res.quantity then
        raise exception 'Reservationsradernas antal stämmer inte' using errcode='23514';
    end if;

    if v_existing = v_total then return; end if;

    select coalesce(jsonb_agg(jsonb_build_object(
        'location_id', location_id, 'quantity', quantity)), '[]'::jsonb)
    into v_previous from public.storefront_stock_reservation_lines
    where reservation_id = v_res.id;

    select quantity into v_available from public.stock_levels
    where item_id=v_res.item_id and location_id=p_location_id for update;
    v_available := coalesce(v_available,0);
    if v_available + v_existing < v_total then
        raise exception 'Det finns inte tillräckligt många lediga exemplar på vald lagerplats'
            using errcode='23514';
    end if;

    -- Update only the net change at each location: avoids transient overflow
    -- when a target location is already part of a split reservation.
    for v_line in
        select location_id, sum(quantity)::integer as quantity
        from public.storefront_stock_reservation_lines
        where reservation_id=v_res.id
        group by location_id
        order by location_id
    loop
        if v_line.location_id = p_location_id then
            v_delta := v_line.quantity - v_total;
        else
            v_delta := v_line.quantity;
        end if;
        if v_delta = 0 then continue; end if;
        select quantity into v_old from public.stock_levels
        where item_id=v_res.item_id and location_id=v_line.location_id for update;
        if v_old is null then raise exception 'Lagerrad saknas' using errcode='23514'; end if;
        v_new := v_old + v_delta;
        if v_new < 0 or v_new > 1000000 then
            raise exception 'Lagervärdet blir ogiltigt' using errcode='23514';
        end if;
        update public.stock_levels set quantity=v_new,updated_at=now()
        where item_id=v_res.item_id and location_id=v_line.location_id;
        insert into public.stock_events(item_id,location_id,previous_quantity,new_quantity,reason,actor_id)
        values(v_res.item_id,v_line.location_id,v_old,v_new,'checkout_reassignment',auth.uid());
    end loop;

    if v_existing = 0 then
        -- No existing reservation at destination; debit it.
        if v_available < v_total then raise exception 'Otillräckligt lager' using errcode='23514'; end if;
        if not exists (
            select 1 from public.stock_levels
            where item_id=v_res.item_id and location_id=p_location_id
        ) then
            raise exception 'Den valda lagerplatsen har inget ledigt saldo'
                using errcode='23514';
        end if;
        update public.stock_levels set quantity=quantity-v_total,updated_at=now()
        where item_id=v_res.item_id and location_id=p_location_id;
        insert into public.stock_events(item_id,location_id,previous_quantity,new_quantity,reason,actor_id)
        values(v_res.item_id,p_location_id,v_available,v_available-v_total,'checkout_reassignment',auth.uid());
    end if;

    delete from public.storefront_stock_reservation_lines where reservation_id=v_res.id;
    insert into public.storefront_stock_reservation_lines(reservation_id,item_id,location_id,quantity)
    values(v_res.id,v_res.item_id,p_location_id,v_total);

    insert into public.order_stock_location_changes
        (order_id,item_id,from_locations,to_location_id,quantity,changed_by)
    values(p_order_id,v_res.item_id,v_previous,p_location_id,v_total,auth.uid());
end;
$fn$;

revoke all on function public.list_paid_order_stock_allocations(),
    public.assign_paid_order_stock_location(uuid,uuid) from public, anon;
grant execute on function public.list_paid_order_stock_allocations(),
    public.assign_paid_order_stock_location(uuid,uuid) to authenticated;
commit;
