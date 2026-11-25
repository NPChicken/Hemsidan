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
    $("auth-layout").hidden = false;
    $("staff-dashboard").hidden = true;
    $("auth-loading").hidden = true;
    views.forEach(view => { $(view).hidden = view !== id; });
    showMessage();
}

function showDashboard(user) {
    const email = user.email || "";
    const first = email.split("@")[0].split(".")[0] || "kollega";
    $("staff-name").textContent = first.charAt(0).toLocaleUpperCase("sv") + first.slice(1);
    $("staff-email").textContent = email;
    $("auth-layout").hidden = true;
    $("staff-dashboard").hidden = false;
    showMessage();
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
