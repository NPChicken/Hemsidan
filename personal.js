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
    orderFetchSequence++;
    cachedOrders = [];
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
