-- SpinRoll UF: sales and social-post analytics, staff-only.
-- Run after staff, orders, stock, deliveries and storefront reservations migrations.
-- This is a READ-only analytics layer (apart from explicitly registered social posts).
begin;

create table if not exists public.marketing_posts (
    id uuid primary key default gen_random_uuid(),
    channel text not null check (channel in ('instagram','tiktok','facebook','youtube','other')),
    title text not null check (length(trim(title)) between 1 and 140),
    published_at timestamptz not null,
    post_url text check (post_url is null or
        (length(post_url) <= 1000 and post_url ~* '^https://[^[:space:]]+$')),
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
);
create index if not exists marketing_posts_published_idx
  on public.marketing_posts(published_at desc);

alter table public.marketing_posts enable row level security;
revoke all on public.marketing_posts from public,anon,authenticated;
grant select on public.marketing_posts to authenticated;
grant all on public.marketing_posts to service_role;
create policy marketing_posts_staff_read on public.marketing_posts
for select to authenticated
using (exists (
    select 1 from public.staff_members sm
    where sm.user_id=(select auth.uid()) and sm.active
));

create function public.add_marketing_post(
    p_channel text,p_title text,p_published_at timestamptz,p_post_url text default null
)
returns uuid language plpgsql security definer set search_path = ''
as $fn$
declare v_id uuid;
begin
    perform public.assert_stock_staff();
    if p_channel is null or p_channel not in ('instagram','tiktok','facebook','youtube','other')
       or p_title is null or length(trim(p_title)) not between 1 and 140
       or p_published_at is null or p_published_at > now() + interval '5 minutes'
       or (p_post_url is not null and trim(p_post_url) <> ''
           and (length(trim(p_post_url))>1000
                or trim(p_post_url) !~* '^https://[^[:space:]]+$')) then
        raise exception 'Ogiltiga inläggsuppgifter' using errcode='22023';
    end if;
    insert into public.marketing_posts(channel,title,published_at,post_url,created_by)
    values(p_channel,trim(p_title),p_published_at,
       nullif(trim(coalesce(p_post_url,'')),''),auth.uid())
    returning id into v_id;
    return v_id;
end;
$fn$;

create function public.delete_marketing_post(p_post_id uuid)
returns void language plpgsql security definer set search_path = ''
as $fn$
begin
    perform public.assert_stock_staff();
    delete from public.marketing_posts p
    where p.id=p_post_id and (
        p.created_by=auth.uid() or exists (
            select 1 from public.staff_members sm
            where sm.user_id=auth.uid() and sm.active and sm.role='admin'
        ));
    if not found then
        raise exception 'Inlägget saknas eller du saknar rättighet att ta bort det'
            using errcode='42501';
    end if;
end;
$fn$;

-- Each sold order item retains its historical selling price.
-- The database only links orders to a stock item where a single-item
-- checkout has a matching reservation and quantity; otherwise cost is unknown.
-- Cost is the weighted average of REAL received delivery costs, excluding
-- test deliveries and voided/reversed/planned receipts.
-- This is an estimated merchandise gross margin, not accounting net profit.
create function public.sales_profit_by_product()
returns table(
    product_name text,
    sold_quantity bigint,
    sales_ore bigint,
    known_cost_ore numeric,
    missing_cost_quantity bigint
)
language plpgsql stable security definer set search_path = ''
as $fn$
begin
    perform public.assert_stock_staff();
    return query
    with costs as (
        select inc.item_id,
          sum(inc.total_cost_ore)::numeric / nullif(sum(inc.quantity),0) as unit_cost
        from public.incoming_stock inc
        where inc.status='received' and inc.is_test=false
          and inc.total_cost_ore is not null
        group by inc.item_id
    ), lines as (
        select oi.product_name,oi.quantity,oi.unit_amount,
          case when (select count(*) from public.order_items oi2
                     where oi2.order_id=oi.order_id)=1
                 and oi.quantity=r.quantity
               then costs.unit_cost
               else null::numeric end as unit_cost
        from public.orders o
        join public.order_items oi on oi.order_id=o.id
        left join public.storefront_stock_reservations r
          on r.stripe_checkout_session_id=o.stripe_checkout_session_id
          and r.status in ('paid','fulfilled')
        left join costs on costs.item_id=r.item_id
        where o.payment_status='paid' and o.stripe_mode='test'
    )
    select lines.product_name,
      sum(lines.quantity)::bigint,
      sum(lines.quantity::bigint*lines.unit_amount::bigint)::bigint,
      coalesce(sum(lines.quantity*lines.unit_cost) filter (where lines.unit_cost is not null),0),
      coalesce(sum(lines.quantity) filter (where lines.unit_cost is null),0)::bigint
    from lines
    group by lines.product_name
    order by sum(lines.quantity::bigint*lines.unit_amount::bigint) desc, lines.product_name;
end;
$fn$;

create function public.sales_trend_by_day(p_from date)
returns table(day date,orders_count bigint,units_sold bigint,sales_ore bigint)
language plpgsql stable security definer set search_path = ''
as $fn$
begin
    perform public.assert_stock_staff();
    if p_from is null or p_from < current_date-interval '3 years'
       or p_from > current_date+interval '1 day' then
        raise exception 'Ogiltigt startdatum' using errcode='22023';
    end if;
    return query
    select (o.created_at at time zone 'Europe/Stockholm')::date,
        count(distinct o.id)::bigint,
        coalesce(sum(oi.quantity),0)::bigint,
        coalesce(sum(oi.quantity::bigint*oi.unit_amount::bigint),0)::bigint
    from public.orders o
    join public.order_items oi on oi.order_id=o.id
    where o.payment_status='paid' and o.stripe_mode='test'
      and (o.created_at at time zone 'Europe/Stockholm')::date >= p_from
    group by 1 order by 1;
end;
$fn$;

revoke all on function public.add_marketing_post(text,text,timestamptz,text),
    public.delete_marketing_post(uuid),
    public.sales_profit_by_product(),
    public.sales_trend_by_day(date) from public,anon;
grant execute on function public.add_marketing_post(text,text,timestamptz,text),
    public.delete_marketing_post(uuid),
    public.sales_profit_by_product(),
    public.sales_trend_by_day(date) to authenticated;

commit;
