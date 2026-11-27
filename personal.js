// SpinRoll UF – publik Supabase-nyckel. Inga hemliga nycklar får användas här.
// Riktig åtkomstkontroll för framtida data måste ske med RLS/serverkontroller.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://bevemgjmcdkcbtsxezsa.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_oOX7KHJwEIGkdiy9ZwMsgw_UlMpW6fA";
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// Supabase Auth identifierar användaren, men medlemskap och orderåtkomst
// kontrolleras av RLS i databasen. Ingen lista med mejladresser i klientkoden.
async function getActiveStaffMembership(userId) {
    const { data, error } = await supabase
        .from("staff_members")
        .select("role, active")
        .eq("user_id", userId)
        .eq("active", true)
        .maybeSingle();
    if (error) throw error;
    return data;
}

const $ = id => document.getElementById(id);
const views = ["login-view", "forgot-view", "recovery-view"];
// En återställningslänk har en egen URL så att initial inloggningshändelse
// aldrig får ta över och öppna personalpanelen av misstag.
const recoveryRedirectUrl = new URL("personal.html?recovery=1", window.location.origin).href;
const recoveryIntent = new URLSearchParams(window.location.search).get("recovery") === "1" ||
    new URLSearchParams(window.location.hash.slice(1)).get("type") === "recovery";
let recoveryMode = recoveryIntent;
let recoveryVerified = false;
let renderSequence = 0;

function clearRecoveryUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete("recovery");
    url.hash = "";
    window.history.replaceState(null, "", url.pathname + url.search);
}

function showMessage(message = "", kind = "error") {
    const node = $("auth-message");
    node.textContent = message;
    node.className = "form-message " + (kind === "success" ? "is-success" : "is-error");
    node.hidden = !message;
}

function showAuthView(id) {
    stockFetchSequence++;
    stockItems = [];
    stockLocations = [];
    stockLevels = [];
    stockIncoming = [];
    catalogPrices = [];
    $("tile-stock-overview").replaceChildren();
    $("tile-stock-overview").appendChild(element("span", "tile-stock-placeholder", "Hämtar lagersaldon…"));
    $("stock-count").textContent = "Laddar…";
    $("stock-prices-list").replaceChildren();
    $("stock-list").replaceChildren();
    $("incoming-list").replaceChildren();
    $("received-list").replaceChildren();
    $("stock-locations-list").replaceChildren();
    $("stock-summary").replaceChildren();
    orderFetchSequence++;
    cachedOrders = [];
    $("tile-order-overview").replaceChildren();
    $("tile-order-overview").appendChild(element("span", "tile-stock-placeholder", "Hämtar beställningar…"));
    $("order-count").textContent = "Laddar…";
    $("auth-layout").hidden = false;
    $("staff-dashboard").hidden = true;
    $("auth-loading").hidden = true;
    views.forEach(view => { $(view).hidden = view !== id; });
    showMessage();
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function kronor(ore, currency = "sek") {
    try {
        return new Intl.NumberFormat("sv-SE", {
            style: "currency", currency: String(currency).toUpperCase(),
            maximumFractionDigits: 2
        }).format((Number(ore) || 0) / 100);
    } catch {
        return String(ore) + " öre";
    }
}

function safeDate(date) {
    if (!date) return "Okänt datum";
    return new Intl.DateTimeFormat("sv-SE", {
        dateStyle: "medium", timeStyle: "short"
    }).format(new Date(date));
}

const STATUS_LABELS = { new: "Ny", packing: "Packas", shipped: "Skickad", cancelled: "Avbruten" };
let cachedOrders = [];
let activeOrderFilter = "all";
let orderFetchSequence = 0;

function orderNotice(message, isError = false) {
    const node = $("order-action-message");
    node.textContent = message;
    node.className = "order-action-message" + (isError ? " is-error" : "");
    node.hidden = !message;
}

function buildOrderCard(order) {
    const card = element("article", "order-card");
    const heading = element("div", "order-card-top");
    const summary = element("div", "order-summary");
    const id = element("strong", "order-reference", "Order · " +
        String(order.stripe_checkout_session_id).slice(-10).toUpperCase());
    const date = element("span", "order-date", safeDate(order.stripe_created_at || order.created_at));
    summary.append(id, date);

    const meta = element("div", "order-meta");
    const name = element("strong", "", order.customer_name || "Namn saknas");
    const amount = element("strong", "order-amount", kronor(order.amount_total, order.currency));
    meta.append(name, amount);
    const statusBadge = element("span", "fulfillment-badge status-" + order.fulfillment_status,
        STATUS_LABELS[order.fulfillment_status] || order.fulfillment_status);
    meta.append(statusBadge);
    heading.append(summary, meta);

    const details = element("details", "order-details");
    const toggle = element("summary", "", "Visa kunduppgifter och hantera order");
    const content = element("div", "order-detail-content");
    const emailRow = element("p", "", "E-post: ");
    if (order.customer_email) {
        const mail = element("a", "", order.customer_email);
        mail.href = "mailto:" + order.customer_email;
        emailRow.appendChild(mail);
    } else {
        emailRow.appendChild(document.createTextNode("Saknas"));
    }
    const status = element("p", "", "Betalning: " +
        (order.payment_status === "paid" ? "Betald" : order.payment_status) +
        " · Leverans: " + (STATUS_LABELS[order.fulfillment_status] || order.fulfillment_status));
    const shipping = [
        order.shipping_name, order.shipping_address_line1,
        order.shipping_address_line2,
        [order.shipping_postal_code, order.shipping_city].filter(Boolean).join(" "),
        order.shipping_country
    ].filter(Boolean).join(", ");
    const shippingRow = element("p", "", "Leveransadress: " + (shipping || "Ej angiven av kassan"));
    const products = element("ul", "order-products");
    for (const item of order.order_items || []) {
        products.appendChild(element("li", "",
            (item.quantity || 1) + " × " + item.product_name +
            " · " + kronor(item.unit_amount, item.currency) + "/st"));
    }
    content.append(emailRow, shippingRow, status, products);

    // Skrivning görs enbart med en autentiserad RPC med behörighetskontroll i databasen.
    if (order.payment_status === "paid" && order.stripe_mode === "test" &&
        ["new", "packing", "shipped"].includes(order.fulfillment_status)) {
        const controls = element("div", "order-status-controls");
        const label = element("label", "", "Ändra leveransstatus");
        const select = element("select", "order-status-select");
        const selectId = "order-status-" + order.id;
        select.id = selectId;
        label.htmlFor = selectId;
        for (const [value, text] of [["new", "Ny"], ["packing", "Packas"], ["shipped", "Skickad"]]) {
            const option = element("option", "", text);
            option.value = value;
            option.selected = value === order.fulfillment_status;
            select.appendChild(option);
        }
        const save = element("button", "save-order-status", "Spara status");
        save.type = "button";
        save.disabled = true;
        select.addEventListener("change", () => {
            save.disabled = select.value === order.fulfillment_status;
        });
        save.addEventListener("click", async () => {
            if (save.disabled || select.value === order.fulfillment_status) return;
            const nextStatus = select.value;
            select.disabled = true;
            save.disabled = true;
            save.textContent = "Sparar…";
            orderNotice();
            try {
                const { error } = await supabase.rpc("set_order_fulfillment_status", {
                    p_order_id: order.id,
                    p_new_status: nextStatus,
                    p_expected_status: order.fulfillment_status
                });
                if (error) throw error;
                orderNotice("Orderns status har ändrats till " + STATUS_LABELS[nextStatus] + ".");
                await loadOrders({ keepNotice: true });
            } catch (error) {
                orderNotice("Status kunde inte sparas. Kontrollera att den nya SQL-funktionen har installerats och försök igen.", true);
                console.error("Could not update fulfillment status:", error.message);
                select.disabled = false;
                save.disabled = select.value === order.fulfillment_status;
                save.textContent = "Spara status";
            }
        });
        controls.append(label, select, save);
        content.appendChild(controls);
    }

    details.append(toggle, content);
    card.append(heading, details);
    return card;
}

function renderDashboardOrderOverview() {
    const overview = $("tile-order-overview");
    overview.replaceChildren();

    // Samma högst 50 testordrar som visas under "Senaste beställningarna".
    const newOrders = cachedOrders.filter(order =>
        order.payment_status === "paid" && order.fulfillment_status === "new");
    const packing = cachedOrders.filter(order =>
        order.payment_status === "paid" && order.fulfillment_status === "packing").length;

    const metrics = element("div", "tile-stock-metrics");
    for (const [label, value] of [["Nya", newOrders.length], ["Packas", packing]]) {
        const metric = element("div", "tile-stock-metric");
        metric.append(element("strong", "", value), element("span", "", label));
        metrics.appendChild(metric);
    }
    overview.appendChild(metrics);

    if (!newOrders.length) {
        overview.appendChild(element("span", "tile-stock-placeholder", "Inga nya beställningar just nu."));
        return;
    }

    const list = element("div", "tile-stock-rows");
    for (const order of newOrders.slice(0, 3)) {
        const entry = element("div", "tile-order-entry");
        const row = element("div", "tile-stock-row");
        const shortRef = String(order.stripe_checkout_session_id || "").slice(-8).toUpperCase();
        row.append(
            element("span", "tile-stock-item-name", order.customer_name || "Order " + shortRef),
            element("strong", "", kronor(order.amount_total, order.currency))
        );
        const productNames = (order.order_items || []).map(item =>
            (item.quantity || 1) + " × " + item.product_name).join(", ");
        const details = element("span", "tile-order-meta",
            (productNames || "Produkter ej angivna") + " · " +
            safeDate(order.stripe_created_at || order.created_at));
        entry.append(row, details);
        list.appendChild(entry);
    }
    overview.appendChild(list);
    if (newOrders.length > 3) {
        overview.appendChild(element("span", "tile-stock-more",
            "+" + (newOrders.length - 3) + " nya beställningar längre ned"));
    }
    if (cachedOrders.length === 50) {
        overview.appendChild(element("span", "tile-stock-more",
            "Visar endast de 50 senaste testordrarna."));
    }
}

function renderOrderList() {
    const counts = { all: cachedOrders.length, new: 0, packing: 0, shipped: 0 };
    cachedOrders.forEach(order => {
        if (Object.hasOwn(counts, order.fulfillment_status)) {
            counts[order.fulfillment_status] += 1;
        }
    });
    for (const button of document.querySelectorAll("[data-order-filter]")) {
        const selected = button.dataset.orderFilter === activeOrderFilter;
        button.classList.toggle("is-active", selected);
        button.setAttribute("aria-pressed", String(selected));
    }
    for (const count of document.querySelectorAll("[data-count-for]")) {
        count.textContent = String(counts[count.dataset.countFor] ?? 0);
    }
    $("order-count").textContent = cachedOrders.length +
        (cachedOrders.length === 50 ? "+ ordrar" : " ordrar");
    renderDashboardOrderOverview();

    const visible = activeOrderFilter === "all"
        ? cachedOrders
        : cachedOrders.filter(order => order.fulfillment_status === activeOrderFilter);
    const message = $("orders-message");
    $("orders-list").replaceChildren();
    if (!visible.length) {
        message.hidden = false;
        message.textContent = cachedOrders.length
            ? "Inga beställningar har den valda statusen."
            : "Inga testordrar än. När en testbetalning görs visas den här.";
        return;
    }
    message.hidden = true;
    const fragment = document.createDocumentFragment();
    visible.forEach(order => fragment.appendChild(buildOrderCard(order)));
    $("orders-list").appendChild(fragment);
}

async function loadOrders({ keepNotice = false } = {}) {
    const seq = ++orderFetchSequence;
    const button = $("refresh-orders");
    const message = $("orders-message");
    button.disabled = true;
    if (!keepNotice) orderNotice();
    message.hidden = false;
    message.textContent = "Hämtar beställningar…";
    $("orders-list").replaceChildren();
    try {
        const { data, error } = await supabase.from("orders")
            .select("id, stripe_checkout_session_id, stripe_created_at, created_at, customer_name, customer_email, shipping_name, shipping_address_line1, shipping_address_line2, shipping_postal_code, shipping_city, shipping_country, amount_total, currency, payment_status, fulfillment_status, stripe_mode, order_items (product_name, quantity, unit_amount, currency)")
            .eq("stripe_mode", "test")
            .order("created_at", { ascending: false })
            .range(0, 49);
        if (error) throw error;
        if (seq !== orderFetchSequence || $("staff-dashboard").hidden) return;
        cachedOrders = data || [];
        renderOrderList();
    } catch (error) {
        if (seq !== orderFetchSequence) return;
        message.textContent = "Kunde inte hämta beställningar. Kontrollera behörigheten och försök igen.";
        $("order-count").textContent = "Ej tillgängligt";
        $("tile-order-overview").replaceChildren();
        $("tile-order-overview").appendChild(element("span", "tile-stock-placeholder",
            "Orderöversikten kunde inte hämtas."));
        console.error("Order list request failed:", error.message);
    } finally {
        if (seq === orderFetchSequence) button.disabled = false;
    }
}

$("refresh-orders").addEventListener("click", () => { void loadOrders(); });
document.querySelectorAll("[data-order-filter]").forEach(button => {
    button.addEventListener("click", () => {
        activeOrderFilter = button.dataset.orderFilter;
        renderOrderList();
    });
});

// Lagerhantering: klienten kan endast läsa RLS-skyddade tabeller och anropa
// begränsade RPC-funktioner för ändringar. Ingen direkt INSERT/UPDATE från webbläsaren.
let stockItems = [];
let stockLocations = [];
let stockLevels = [];
let stockIncoming = [];
let catalogPrices = [];
let stockFetchSequence = 0;

function stockMessage(message, error = false) {
    const node = $("stock-message");
    node.textContent = message;
    node.classList.toggle("is-error", error);
    node.hidden = !message;
}

function stockOptionList(id, entries, placeholder) {
    const select = $(id);
    const previous = select.value;
    select.replaceChildren();
    const blank = element("option", "", placeholder);
    blank.value = "";
    select.appendChild(blank);
    for (const entry of entries) {
        const opt = element("option", "", entry.name);
        opt.value = entry.id;
        select.appendChild(opt);
    }
    if (entries.some(e => e.id === previous)) select.value = previous;
}

function stockName(id, list) {
    return list.find(entry => entry.id === id)?.name || "Okänd";
}

// Ta bort från det aktiva lagret genom arkivering. Historiska leveranser behålls.
async function archiveStockEntry(kind, entry, button) {
    const isItem = kind === "item";
    const description = isItem ? "artikeln" : "lagerplatsen";
    if (!window.confirm("Vill du ta bort " + description + ' "' + entry.name +
        '"? Historiken sparas. Saldo måste vara 0 och inga leveranser får vänta.')) return;

    button.disabled = true;
    const oldLabel = button.textContent;
    button.textContent = "Tar bort…";
    stockMessage();
    try {
        const { error } = await supabase.rpc(isItem ? "archive_stock_item" : "archive_stock_location",
            isItem ? { p_item_id: entry.id } : { p_location_id: entry.id });
        if (error) throw error;
        await loadStock();
        stockMessage((isItem ? "Artikeln" : "Lagerplatsen") + " har tagits bort från det aktiva lagret.");
    } catch (error) {
        stockMessage("Kunde inte ta bort " + description + ": " + (error.message || "Okänt fel"), true);
        console.error("Archive stock failed:", error.message);
        button.disabled = false;
        button.textContent = oldLabel;
    }
}

function stockArchiveButton(kind, entry, reason = "") {
    const button = element("button", "stock-archive-button",
        kind === "item" ? "Ta bort artikel" : "Ta bort lagerplats");
    button.type = "button";
    if (reason) {
        button.disabled = true;
        button.title = reason;
    } else {
        button.addEventListener("click", () => { void archiveStockEntry(kind, entry, button); });
    }
    return button;
}

// Butikspriser – visas i personalpanelen och lagras med personalbehörighet.
// Kassans Stripe Worker måste hämta effective_price_ore på serversidan.
function priceToInput(ore) {
    return ore == null ? "" : (ore / 100).toFixed(2);
}

function inputToOre(value) {
    const text = String(value).trim().replace(",", ".");
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return null;
    const [whole, fractional = ""] = text.split(".");
    return Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
}

function renderCatalogPriceForms() {
    const list = $("stock-prices-list");
    list.replaceChildren();
    const active = stockItems.filter(x => !x.archived_at);
    if (!active.length) {
        list.appendChild(element("p", "stock-muted", "Skapa först en artikel i lagret."));
        return;
    }
    for (const item of active) {
        const saved = catalogPrices.find(p => p.item_id === item.id);
        const form = element("form", "stock-price-form");
        const heading = element("h4", "", item.name);
        const info = element("p", "stock-muted", item.sku
            ? "Artikelnummer: " + item.sku : "Inget artikelnummer");
        const label = (input, text) => {
            const l = element("label", "", text);
            l.htmlFor = input.id;
            return l;
        };
        const regular = element("input");
        regular.id = "regular-price-" + item.id;
        regular.type = "number";
        regular.step = "0.01";
        regular.min = "0.01";
        regular.max = "1000000";
        regular.required = true;
        regular.value = priceToInput(saved?.regular_price_ore);
        regular.placeholder = "249,00";

        const sale = element("input");
        sale.id = "sale-price-" + item.id;
        sale.type = "number";
        sale.step = "0.01";
        sale.min = "0.01";
        sale.max = "1000000";
        sale.value = priceToInput(saved?.sale_price_ore);
        sale.placeholder = "199,00 (valfritt)";

        // Svensk datumordning oavsett webbläsarens regionala inställningar.
        const until = element("input");
        until.id = "sale-until-" + item.id;
        until.type = "text";
        until.inputMode = "numeric";
        until.placeholder = "ÅÅÅÅ-MM-DD";
        until.maxLength = 10;
        until.pattern = "[0-9]{4}-[0-9]{2}-[0-9]{2}";

        const untilTime = element("input");
        untilTime.id = "sale-until-time-" + item.id;
        untilTime.type = "text";
        untilTime.inputMode = "numeric";
        untilTime.placeholder = "HH:MM";
        untilTime.maxLength = 5;
        untilTime.pattern = "[0-9]{2}:[0-9]{2}";
        if (saved?.sale_ends_at) {
            const end = new Date(saved.sale_ends_at);
            const local = new Date(end.getTime() - end.getTimezoneOffset() * 60000);
            const [date, time] = local.toISOString().slice(0, 16).split("T");
            until.value = date;
            untilTime.value = time;
        }

        const key = element("select");
        key.id = "storefront-key-" + item.id;
        for (const [value, title] of [
            ["", "Ingen webbkoppling"],
            ["website", "website – hemsidan och kassan"]
        ]) {
            const option = element("option", "", title);
            option.value = value;
            key.appendChild(option);
        }
        // Acceptera också tidigare inställningar innan SQL-migrationen körts.
        key.value = saved?.storefront_key === "exile" ? "website" : (saved?.storefront_key || "");

        const fields = element("div", "stock-price-fields");
        const field = (node, title) => {
            const wrapper = element("div", "stock-price-field");
            wrapper.append(label(node, title), node);
            fields.appendChild(wrapper);
        };
        field(regular, "Ordinarie pris (kr)");
        field(sale, "Kampanjpris (kr)");
        field(until, "Kampanjen slutar – datum (ÅÅÅÅ-MM-DD)");
        field(untilTime, "Kampanjen slutar – klockslag (HH:MM)");
        field(key, "Website (butikskoppling)");
        const hint = element("p", "stock-muted",
            "Kampanjpris och slutdatum ska fyllas i tillsammans. Lämna båda tomma för att ta bort kampanjen. " +
            "Välj website för artikeln som ska styra priset på startsidan, Exile-sidan, i kundvagnen och Stripe-kassan.");
        const status = element("p", "stock-cost", saved?.sale_price_ore && saved?.sale_ends_at &&
            new Date(saved.sale_ends_at) > new Date()
            ? "Aktuellt pris: " + kronor(saved.sale_price_ore)
            : saved ? "Aktuellt pris: " + kronor(saved.regular_price_ore)
                : "Inget pris registrerat");
        const save = element("button", "stock-submit", "Spara pris");
        save.type = "submit";
        const feedback = element("p", "stock-muted");
        feedback.setAttribute("role", "status");
        feedback.setAttribute("aria-live", "polite");
        form.append(heading, info, fields, hint, status, save, feedback);
        form.addEventListener("submit", async event => {
            event.preventDefault();
            const regularOre = inputToOre(regular.value);
            const saleOre = sale.value.trim() ? inputToOre(sale.value) : null;
            const hasDate = until.value.trim() !== "";
            const hasTime = untilTime.value.trim() !== "";
            const datetime = hasDate && hasTime ? until.value.trim() + "T" + untilTime.value.trim() : "";
            const saleDate = datetime ? new Date(datetime) : null;
            const validDate = !datetime || (
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(datetime) &&
                Number.isFinite(saleDate.getTime()) &&
                [saleDate.getFullYear(), String(saleDate.getMonth() + 1).padStart(2, "0"),
                 String(saleDate.getDate()).padStart(2, "0")].join("-") +
                 "T" + String(saleDate.getHours()).padStart(2, "0") +
                 ":" + String(saleDate.getMinutes()).padStart(2, "0") === datetime
            );
            if (regularOre == null || regularOre < 1 || regularOre > 100000000 ||
                hasDate !== hasTime ||
                Boolean(sale.value.trim()) !== hasDate || !validDate ||
                (saleOre != null && (saleOre < 1 || saleOre >= regularOre)) ||
                (saleDate && saleDate <= new Date())) {
                const msg = "Kontrollera priset och skriv slutdatum som ÅÅÅÅ-MM-DD och klockslag som HH:MM. Kampanjpriset måste vara lägre än ordinarie pris.";
                feedback.textContent = msg;
                stockMessage(msg, true);
                return;
            }
            save.disabled = true;
            save.textContent = "Sparar…";
            feedback.textContent = "Sparar pris…";
            stockMessage();
            try {
                const { error } = await supabase.rpc("save_catalog_price", {
                    p_item_id: item.id,
                    p_regular_price_ore: regularOre,
                    p_sale_price_ore: saleOre,
                    p_sale_ends_at: saleDate?.toISOString() || null,
                    p_storefront_key: key.value.trim() || null
                });
                if (error) throw error;
                await loadStock({ throwOnError: true });
                stockMessage("Priset för " + item.name + " är sparat. Obs: Stripe Workern måste också använda pris-API:et.");
            } catch (error) {
                const msg = "Kunde inte spara pris: " + (error.message || "Okänt fel");
                feedback.textContent = msg;
                stockMessage(msg, true);
                console.error("Price save failed:", error);
            } finally {
                save.disabled = false;
                save.textContent = "Spara pris";
            }
        });
        list.appendChild(form);
    }
}

function renderDashboardStockOverview() {
    const overview = $("tile-stock-overview");
    overview.replaceChildren();

    const activeItems = stockItems.filter(item => !item.archived_at);
    if (!activeItems.length) {
        overview.appendChild(element("span", "tile-stock-placeholder", "Inga artiklar registrerade ännu."));
        return;
    }

    const perItem = activeItems.map(item => ({
        item,
        quantity: stockLevels.filter(level => level.item_id === item.id)
            .reduce((total, level) => total + level.quantity, 0),
        incoming: stockIncoming.filter(delivery =>
            delivery.item_id === item.id && delivery.status === "planned")
            .reduce((total, delivery) => total + delivery.quantity, 0)
    }));

    const totals = element("div", "tile-stock-metrics");
    const totalInStock = perItem.reduce((total, row) => total + row.quantity, 0);
    const totalOnWay = perItem.reduce((total, row) => total + row.incoming, 0);
    for (const [label, value] of [
        ["I lager", totalInStock],
        ["På väg", totalOnWay]
    ]) {
        const metric = element("div", "tile-stock-metric");
        metric.append(element("strong", "", value), element("span", "", label));
        totals.appendChild(metric);
    }
    overview.appendChild(totals);

    const list = element("div", "tile-stock-rows");
    for (const row of perItem.slice(0, 3)) {
        const line = element("div", "tile-stock-row");
        line.append(
            element("span", "tile-stock-item-name", row.item.name),
            element("strong", "", row.quantity + " " + (row.item.unit || "st"))
        );
        list.appendChild(line);
        if (row.incoming > 0) {
            list.appendChild(element("div", "tile-stock-incoming",
                "+" + row.incoming + " " + (row.item.unit || "st") + " på väg"));
        }
    }
    overview.appendChild(list);
    if (perItem.length > 3) {
        overview.appendChild(element("span", "tile-stock-more",
            "Och " + (perItem.length - 3) + " artiklar till längre ned"));
    }
}

function renderStock() {
    renderCatalogPriceForms();
    const activeItems = stockItems.filter(item => !item.archived_at);
    const activeLocations = stockLocations.filter(location => !location.archived_at);
    stockOptionList("stock-level-item", activeItems, "Välj artikel");
    stockOptionList("incoming-item", activeItems, "Välj artikel");
    stockOptionList("stock-level-location", activeLocations, "Välj lagerplats");
    stockOptionList("incoming-location", activeLocations, "Välj lagerplats");

    const quantity = stockLevels.reduce((sum, x) => sum + x.quantity, 0);
    const pending = stockIncoming.filter(x => x.status === "planned");
    const pendingQuantity = pending.reduce((sum, x) => sum + x.quantity, 0);
    const received = stockIncoming.filter(x => x.status === "received");
    const knownPendingCost = pending.reduce((sum, x) => sum + (x.total_cost_ore ?? 0), 0);
    const knownReceivedCost = received.reduce((sum, x) => sum + (x.total_cost_ore ?? 0), 0);
    $("stock-count").textContent = activeItems.length + " artiklar";
    renderDashboardStockOverview();
    const summary = $("stock-summary");
    summary.replaceChildren();
    for (const [label, value] of [
        ["Artiklar", activeItems.length],
        ["Antal i lager", quantity],
        ["På väg", pendingQuantity],
        ["Lagerplatser", activeLocations.length],
        ["Planerade inköp", kronor(knownPendingCost)],
        ["Mottagna inköp", kronor(knownReceivedCost)]
    ]) {
        const card = element("div", "stock-stat");
        card.append(element("span", "", label), element("strong", "", value));
        summary.appendChild(card);
    }

    const list = $("stock-list");
    list.replaceChildren();
    if (!activeItems.length) {
        list.appendChild(element("p", "stock-muted", "Inga artiklar ännu. Börja med att lägga till en artikel och en lagerplats."));
    }
    for (const item of activeItems) {
        const card = element("div", "stock-entry");
        const name = element("strong", "", item.name);
        if (item.sku) name.appendChild(element("small", "stock-sku", " · " + item.sku));
        card.appendChild(name);
        const itemLevels = stockLevels.filter(level => level.item_id === item.id && level.quantity > 0);
        if (!itemLevels.length) card.appendChild(element("p", "stock-muted", "0 " + item.unit + " registrerade"));
        for (const level of itemLevels) {
            const row = element("div", "stock-entry-line");
            row.append(element("span", "", stockName(level.location_id, stockLocations)),
                       element("strong", "", level.quantity + " " + item.unit));
            card.appendChild(row);
        }
        const total = stockLevels.filter(level => level.item_id === item.id).reduce((sum, x) => sum + x.quantity, 0);
        card.appendChild(element("div", "stock-total", "Totalt: " + total + " " + item.unit));
        const hasPending = stockIncoming.some(delivery => delivery.item_id === item.id && delivery.status === "planned");
        const reason = total > 0 ? "Artikeln har saldo kvar. Inventera till 0 först."
            : hasPending ? "Artikeln har en kommande leverans." : "";
        card.appendChild(stockArchiveButton("item", item, reason));
        if (reason) card.appendChild(element("p", "stock-muted", reason));
        list.appendChild(card);
    }

    const locationsList = $("stock-locations-list");
    locationsList.replaceChildren();
    if (!activeLocations.length) {
        locationsList.appendChild(element("p", "stock-muted", "Inga lagerplatser ännu. Lägg till en lagerplats nedan."));
    }
    for (const location of activeLocations) {
        const card = element("div", "stock-entry");
        card.appendChild(element("strong", "", location.name));
        card.appendChild(element("p", "stock-muted", location.description || "Ingen beskrivning angiven."));
        const used = stockLevels.filter(level => level.location_id === location.id)
            .reduce((total, level) => total + level.quantity, 0);
        card.appendChild(element("div", "stock-total", "Antal på platsen: " + used));
        const hasPending = stockIncoming.some(delivery =>
            delivery.location_id === location.id && delivery.status === "planned");
        const reason = used > 0 ? "Platsen har saldo kvar. Inventera till 0 eller flytta lagret först."
            : hasPending ? "Lagerplatsen har en kommande leverans." : "";
        card.appendChild(stockArchiveButton("location", location, reason));
        if (reason) card.appendChild(element("p", "stock-muted", reason));
        locationsList.appendChild(card);
    }

    const incomingList = $("incoming-list");
    incomingList.replaceChildren();
    if (!pending.length) incomingList.appendChild(element("p", "stock-muted", "Inga kommande leveranser registrerade."));
    for (const delivery of pending.sort((a, b) => (a.expected_on || "9999").localeCompare(b.expected_on || "9999"))) {
        const card = element("div", "stock-entry");
        const item = stockItems.find(x => x.id === delivery.item_id);
        const heading = element("div", "stock-entry-line");
        heading.append(
            element("strong", "", item?.name || "Okänd artikel"),
            element("strong", "", "+" + delivery.quantity + " " + (item?.unit || "st"))
        );
        card.appendChild(heading);
        card.appendChild(element("p", "stock-muted", "Till " + stockName(delivery.location_id, stockLocations) +
            (delivery.expected_on ? " · Beräknat " + delivery.expected_on : " · Inget datum")));
        card.appendChild(element("p", "stock-cost", delivery.total_cost_ore == null
            ? "Kostnad: ej angiven" : "Total kostnad: " + kronor(delivery.total_cost_ore)));
        if (delivery.supplier) card.appendChild(element("p", "stock-muted", "Leverantör: " + delivery.supplier));
        if (delivery.notes) card.appendChild(element("p", "stock-muted", delivery.notes));
        const receive = element("button", "stock-receive", "Markera som mottagen");
        receive.type = "button";
        receive.addEventListener("click", async () => {
            if (!window.confirm("Har leveransen verkligen kommit fram? " +
                delivery.quantity + " " + (item?.unit || "st") + " läggs till i lagret.")) return;
            receive.disabled = true;
            receive.textContent = "Registrerar…";
            try {
                const { error } = await supabase.rpc("receive_incoming_stock", {
                    p_incoming_id: delivery.id
                });
                if (error) throw error;
                await loadStock();
                stockMessage("Leveransen är mottagen och lagersaldot har uppdaterats.");
            } catch (error) {
                stockMessage("Kunde inte ta emot leveransen. " + (error.code === "PGRST202"
                    ? "Kontrollera att lager-SQL är installerad." : "Försök uppdatera listan."), true);
                console.error("Stock receipt failed:", error.message);
                receive.disabled = false;
                receive.textContent = "Markera som mottagen";
            }
        });
        card.appendChild(receive);
        incomingList.appendChild(card);
    }

    const receivedList = $("received-list");
    receivedList.replaceChildren();
    if (!received.length) receivedList.appendChild(element("p", "stock-muted", "Inga mottagna leveranser än."));
    for (const delivery of received.slice(0, 30)) {
        const card = element("div", "stock-entry");
        const item = stockItems.find(x => x.id === delivery.item_id);
        const top = element("div", "stock-entry-line");
        top.append(
            element("strong", "", item?.name || "Okänd artikel"),
            element("span", "", delivery.quantity + " " + (item?.unit || "st"))
        );
        card.appendChild(top);
        card.appendChild(element("p", "stock-muted", "Mottagen till " +
            stockName(delivery.location_id, stockLocations)));
        card.appendChild(element("p", "stock-cost", delivery.total_cost_ore == null
            ? "Kostnad: ej angiven" : "Total kostnad: " + kronor(delivery.total_cost_ore)));
        if (delivery.supplier) card.appendChild(element("p", "stock-muted", "Leverantör: " + delivery.supplier));
        receivedList.appendChild(card);
    }
}

async function loadStock({ throwOnError = false } = {}) {
    const seq = ++stockFetchSequence;
    $("refresh-stock").disabled = true;
    stockMessage("Hämtar lagret…");
    try {
        const [items, locations, levels, incoming, prices] = await Promise.all([
            supabase.from("stock_items").select("id,name,sku,unit,archived_at").order("name"),
            supabase.from("stock_locations").select("id,name,description,archived_at").order("name"),
            supabase.from("stock_levels").select("item_id,location_id,quantity"),
            supabase.from("incoming_stock").select("id,item_id,location_id,quantity,total_cost_ore,supplier,expected_on,notes,status").order("created_at", {ascending:false}).limit(200),
            supabase.from("catalog_prices").select("item_id,storefront_key,regular_price_ore,sale_price_ore,sale_ends_at")
        ]);
        const error = [items,locations,levels,incoming,prices].find(r => r.error)?.error;
        if (error) throw error;
        if (seq !== stockFetchSequence || $("staff-dashboard").hidden) return;
        stockItems = items.data || [];
        stockLocations = locations.data || [];
        stockLevels = levels.data || [];
        stockIncoming = incoming.data || [];
        catalogPrices = prices.data || [];
        renderStock();
        stockMessage();
    } catch (error) {
        if (seq !== stockFetchSequence) return;
        const missingArchive = error.code === "42703" ||
            (error.message || "").includes("archived_at") ||
            error.code === "PGRST204";
        stockMessage(missingArchive
            ? "Databasen saknar lagerarkiveringens fält. Kör SQL-filen 20261127150000_archive_stock.sql i Supabase."
            : "Kunde inte läsa lagerlistan: " + (error.message || "Okänt fel"), true);
        $("tile-stock-overview").replaceChildren();
        $("tile-stock-overview").appendChild(element("span", "tile-stock-placeholder",
            "Lageröversikten kunde inte hämtas."));
        $("stock-count").textContent = "Ej tillgängligt";
        console.error("Stock fetch failed:", error);
        if (throwOnError) throw error;
    } finally {
        if (seq === stockFetchSequence) $("refresh-stock").disabled = false;
    }
}

$("refresh-stock").addEventListener("click", () => { void loadStock(); });

async function submitStockForm(formId, functionName, buildParams, successMessage) {
    const form = $(formId);
    form.addEventListener("submit", async event => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        stockMessage();
        try {
            const { error } = await supabase.rpc(functionName, buildParams());
            if (error) throw error;
            form.reset();
            try {
                await loadStock({ throwOnError: true });
                stockMessage(successMessage);
            } catch {
                stockMessage("Uppgiften sparades i databasen, men lagerlistan kunde inte uppdateras. Kontrollera om SQL-filen för arkivering är installerad.", true);
            }
        } catch (error) {
            const reason = error.code === "23505" ? "Artikelnummer eller lagerplatsnamn används redan."
                : error.code === "PGRST202" ? "Databasfunktionen hittades inte. Kontrollera att lager-SQL har körts."
                : (error.message || "Okänt fel");
            stockMessage("Kunde inte spara: " + reason, true);
            console.error(functionName + " failed:", error);
        } finally {
            button.disabled = false;
        }
    });
}

submitStockForm("stock-item-form", "add_stock_item", () => ({
    p_name: $("stock-item-name").value.trim(),
    p_sku: $("stock-item-sku").value.trim() || null,
    p_unit: $("stock-item-unit").value.trim()
}), "Artikeln har lagts till.");

submitStockForm("stock-location-form", "add_stock_location", () => ({
    p_name: $("stock-location-name").value.trim(),
    p_description: $("stock-location-description").value.trim() || null
}), "Lagerplatsen har lagts till.");

submitStockForm("stock-level-form", "set_stock_level", () => ({
    p_item_id: $("stock-level-item").value,
    p_location_id: $("stock-level-location").value,
    p_quantity: Number($("stock-level-quantity").value)
}), "Lagersaldot har sparats.");

submitStockForm("incoming-form", "add_incoming_stock", () => ({
    p_item_id: $("incoming-item").value,
    p_location_id: $("incoming-location").value,
    p_quantity: Number($("incoming-quantity").value),
    p_supplier: $("incoming-supplier").value.trim() || null,
    p_expected_on: $("incoming-date").value || null,
    p_notes: $("incoming-notes").value.trim() || null,
    p_total_cost_ore: $("incoming-cost").value.trim() === ""
        ? null : Math.round(Number($("incoming-cost").value) * 100)
}), "Den kommande leveransen har registrerats.");

function showDashboard(user) {
    if (recoveryMode) return;
    const email = user.email || "";
    const first = email.split("@")[0].split(".")[0] || "kollega";
    $("staff-name").textContent = first.charAt(0).toLocaleUpperCase("sv") + first.slice(1);
    $("staff-email").textContent = email;
    $("auth-layout").hidden = true;
    $("staff-dashboard").hidden = false;
    showMessage();
    void loadOrders();
    void loadStock();
}

async function renderSession(session) {
    const seq = ++renderSequence;
    if (recoveryMode) {
        if (session?.user && recoveryVerified) {
            showAuthView("recovery-view");
        } else {
            showAuthView("login-view");
            showMessage("Återställningslänken kunde inte verifieras eller har gått ut. Begär en ny länk via Glömt lösenordet.");
        }
        return;
    }
    if (!session?.user) {
        showAuthView("login-view");
        return;
    }
    try {
        const membership = await getActiveStaffMembership(session.user.id);
        if (seq !== renderSequence || recoveryMode) return;
        if (!membership) {
            showAuthView("login-view");
            showMessage("Ditt konto är inloggat men har inte personalbehörighet. Be administratören lägga till dig i Supabase.");
            return;
        }
        showDashboard(session.user);
    } catch (error) {
        if (seq !== renderSequence || recoveryMode) return;
        showAuthView("login-view");
        showMessage("Kunde inte kontrollera personalbehörigheten. Databasmigrationen kanske inte har körts ännu.");
        console.error("Staff membership lookup failed:", error.message);
    }
}

function setWorking(button, working, label) {
    button.disabled = working;
    button.textContent = working ? "Arbetar…" : label;
}

$("login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("login-submit");
    showMessage();
    setWorking(button, true, "Logga in ↗");
    try {
        const { data, error } = await supabase.auth.signInWithPassword({
            email: $("login-email").value.trim(),
            password: $("login-password").value
        });
        $("login-password").value = "";
        if (error) throw error;
        await renderSession(data.session);
    } catch (error) {
        showMessage("Kunde inte logga in. Kontrollera e-postadress och lösenord och försök igen.");
        console.error("Supabase login failed:", error.message);
    } finally {
        setWorking(button, false, "Logga in ↗");
    }
});

$("show-forgot").addEventListener("click", () => {
    $("forgot-email").value = $("login-email").value;
    showAuthView("forgot-view");
});
$("back-to-login").addEventListener("click", () => showAuthView("login-view"));

$("forgot-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("forgot-submit");
    showMessage();
    setWorking(button, true, "Skicka återställningslänk ↗");
    try {
        const { error } = await supabase.auth.resetPasswordForEmail($("forgot-email").value.trim(), {
            redirectTo: recoveryRedirectUrl
        });
        if (error) throw error;
        showMessage("Om adressen finns registrerad skickas en återställningslänk. Kontrollera även skräpposten.", "success");
    } catch (error) {
        showMessage("Det gick inte att skicka mejlet just nu. Försök igen senare eller kontakta administratören.");
        console.error("Password reset failed:", error.message);
    } finally {
        setWorking(button, false, "Skicka återställningslänk ↗");
    }
});

$("recovery-form").addEventListener("submit", async event => {
    event.preventDefault();
    const password = $("new-password").value;
    if (password !== $("confirm-password").value) {
        showMessage("Lösenorden matchar inte.");
        return;
    }
    const button = $("recovery-submit");
    setWorking(button, true, "Spara nytt lösenord ↗");
    try {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        $("recovery-form").reset();
        recoveryMode = false;
        recoveryVerified = false;
        clearRecoveryUrl();
        // En återställningslänk skapar en kortvarig session. Logga ut efter
        // lösenordsbytet så att användaren loggar in med sitt nya lösenord.
        const { error: signOutError } = await supabase.auth.signOut();
        if (signOutError) throw signOutError;
        $("login-form").reset();
        showAuthView("login-view");
        showMessage("Lösenordet är uppdaterat. Logga in med ditt nya lösenord.", "success");
    } catch (error) {
        showMessage("Det gick inte att uppdatera lösenordet. Be om en ny återställningslänk och försök igen.");
        console.error("Password update failed:", error.message);
    } finally {
        setWorking(button, false, "Spara nytt lösenord ↗");
    }
});

$("logout-button").addEventListener("click", async () => {
    const button = $("logout-button");
    button.disabled = true;
    const { error } = await supabase.auth.signOut();
    button.disabled = false;
    if (error) {
        window.alert("Det gick inte att logga ut. Försök igen.");
        return;
    }
    $("login-form").reset();
    showAuthView("login-view");
});

// Prenumerera före getSession så att återställningslänkar fångas upp.
supabase.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
        recoveryMode = true;
        recoveryVerified = true;
    }
    if (event === "SIGNED_OUT" && !recoveryMode) recoveryVerified = false;
    // Den särskilda återställnings-URL:en tar alltid företräde framför
    // INITIAL_SESSION/SIGNED_IN, som annars kan visa dashboarden.
    queueMicrotask(() => { void renderSession(session); });
});

(async () => {
    try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        await renderSession(data.session);
    } catch (error) {
        showAuthView("login-view");
        showMessage("Kunde inte ansluta till inloggningstjänsten. Ladda om sidan och försök igen.");
        console.error("Supabase session failed:", error.message);
    }
})();
