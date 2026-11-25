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
let recoveryMode = false;

function showMessage(message = "", kind = "error") {
    const node = $("auth-message");
    node.textContent = message;
    node.className = "form-message " + (kind === "success" ? "is-success" : "is-error");
    node.hidden = !message;
}

function showAuthView(id) {
    orderFetchSequence++;
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
    heading.append(summary, meta);

    const details = element("details", "order-details");
    const toggle = element("summary", "", "Visa kunduppgifter och produkter");
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
        " · Leverans: " + ({
            new: "Ny", packing: "Packas", shipped: "Skickad", cancelled: "Avbruten"
        }[order.fulfillment_status] || order.fulfillment_status));
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
    details.append(toggle, content);
    card.append(heading, details);
    return card;
}

let orderFetchSequence = 0;
async function loadOrders() {
    const seq = ++orderFetchSequence;
    const button = $("refresh-orders");
    const message = $("orders-message");
    button.disabled = true;
    message.hidden = false;
    message.textContent = "Hämtar beställningar…";
    $("orders-list").replaceChildren();
    try {
        const { data, error } = await supabase.from("orders")
            .select("id, stripe_checkout_session_id, stripe_created_at, created_at, customer_name, customer_email, shipping_name, shipping_address_line1, shipping_address_line2, shipping_postal_code, shipping_city, shipping_country, amount_total, currency, payment_status, fulfillment_status, order_items (product_name, quantity, unit_amount, currency)")
            .eq("stripe_mode", "test")
            .order("created_at", { ascending: false })
            .range(0, 49);
        if (error) throw error;
        if (seq !== orderFetchSequence || $("staff-dashboard").hidden) return;
        const orders = data || [];
        $("order-count").textContent = orders.length === 0 ? "0 ordrar" :
            orders.length + (orders.length === 50 ? "+ ordrar" : " ordrar");
        if (!orders.length) {
            message.textContent = "Inga testordrar än. När webhooken är aktiv och en testbetalning görs visas den här.";
            return;
        }
        message.hidden = true;
        const fragment = document.createDocumentFragment();
        orders.forEach(order => fragment.appendChild(buildOrderCard(order)));
        $("orders-list").appendChild(fragment);
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

function showDashboard(user) {
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
    if (recoveryMode) {
        showAuthView("recovery-view");
        return;
    }
    if (!session?.user) {
        showAuthView("login-view");
        return;
    }
    try {
        const membership = await getActiveStaffMembership(session.user.id);
        if (!membership) {
            showAuthView("login-view");
            showMessage("Ditt konto är inloggat men har inte personalbehörighet. Be administratören lägga till dig i Supabase.");
            return;
        }
        showDashboard(session.user);
    } catch (error) {
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
        const redirectTo = new URL("personal.html", window.location.href).href;
        const { error } = await supabase.auth.resetPasswordForEmail($("forgot-email").value.trim(), { redirectTo });
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
        const { data } = await supabase.auth.getSession();
        await renderSession(data.session);
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
    if (event === "PASSWORD_RECOVERY") recoveryMode = true;
    if (event === "SIGNED_OUT") recoveryMode = false;
    // Undvik async-anrop till Supabase direkt i auth-callbacken.
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
