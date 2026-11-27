-- Sources for automatic Instagram / TikTok post synchronisation.
-- Official API credentials remain in Cloudflare Worker secrets, never in this database.
begin;
alter table public.marketing_posts
  add column source text not null default 'manual'
    check (source in ('manual','instagram','tiktok'));
alter table public.marketing_posts
  add column external_id text;
alter table public.marketing_posts
  add constraint marketing_posts_source_identity_check
    check ((source='manual' and external_id is null)
       or (source in ('instagram','tiktok') and external_id is not null
           and length(external_id) between 1 and 150));
create unique index marketing_posts_source_external_id_idx
  on public.marketing_posts(source,external_id);

create table public.social_sync_status (
  channel text primary key check(channel in ('instagram','tiktok')),
  last_success_at timestamptz,
  last_error_at timestamptz,
  error_message text,
  posts_seen integer not null default 0
);
alter table public.social_sync_status enable row level security;
revoke all on public.social_sync_status from public,anon,authenticated;
grant select on public.social_sync_status to authenticated;
grant all on public.social_sync_status to service_role;
create policy social_sync_status_staff_read
on public.social_sync_status for select to authenticated
using (exists(select 1 from public.staff_members s
   where s.user_id=(select auth.uid()) and s.active));

-- Synced posts are maintained by Cloudflare Worker, not edited or removed
-- by ordinary staff accounts.
create or replace function public.delete_marketing_post(p_post_id uuid)
returns void language plpgsql security definer set search_path = ''
as $fn$
begin
  perform public.assert_stock_staff();
  delete from public.marketing_posts p
   where p.id=p_post_id and p.source='manual'
     and (p.created_by=auth.uid() or exists (
        select 1 from public.staff_members s
         where s.user_id=auth.uid() and s.active and s.role='admin'
     ));
  if not found then
     raise exception 'Endast manuella inlägg kan tas bort här' using errcode='42501';
  end if;
end;
$fn$;

-- Staff cannot forge official API-sourced posts via the manual RPC.
-- Its existing insert remains source=manual by default.
commit;
