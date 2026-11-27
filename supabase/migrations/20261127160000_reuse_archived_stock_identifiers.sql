-- SpinRoll UF: allow new active articles and locations to reuse archived identifiers.
-- Requires 20261127120000_stock_management.sql and 20261127150000_archive_stock.sql.
-- Old rows are kept for order, cost and inventory history.
begin;

-- Existing UNIQUE constraints also included archived rows, preventing re-creation.
alter table public.stock_items
    drop constraint if exists stock_items_sku_key;
alter table public.stock_locations
    drop constraint if exists stock_locations_name_key;

-- Uniqueness only among active rows. PostgreSQL permits multiple NULL SKU values.
create unique index if not exists stock_items_active_sku_unique
    on public.stock_items (sku)
    where archived_at is null;

create unique index if not exists stock_locations_active_name_unique
    on public.stock_locations (name)
    where archived_at is null;

commit;
