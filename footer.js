/* SpinRoll UF – bekräftelse för Brevos inbäddade formulär.
   Brevos egen main.js sköter sändning och validering.
   Visa popup först när Brevos success-panel faktiskt blir aktiv. */
document.addEventListener("DOMContentLoaded", () => {
    const form = document.querySelector(".spinroll-footer #sib-form");
    const successPanel = document.querySelector(".spinroll-footer #success-message");
    if (!form || !successPanel) return;

    const popup = document.createElement("div");
    popup.id = "spinroll-newsletter-popup";
    popup.className = "spinroll-newsletter-popup";
    popup.hidden = true;
    popup.innerHTML = `
        <div class="spinroll-newsletter-backdrop"></div>
        <section class="spinroll-newsletter-dialog" role="dialog"
                 aria-modal="true" aria-labelledby="spinroll-newsletter-title"
                 aria-describedby="spinroll-newsletter-description" tabindex="-1">
            <button class="spinroll-newsletter-close" type="button"
                    aria-label="Stäng bekräftelsen">×</button>
            <svg class="spinroll-newsletter-check" width="52" height="52"
                 viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                 aria-hidden="true">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="m7 12 3.5 3.5L17 9"></path>
            </svg>
            <h2 id="spinroll-newsletter-title">Bekräfta din e-postadress</h2>
            <p id="spinroll-newsletter-description">
                Tack för att du vill följa SpinRoll! Vi har tagit emot din anmälan.
                Öppna mejlet från oss och klicka på bekräftelselänken
                för att slutföra din prenumeration. Kolla även skräpposten
                om du inte hittar mejlet.
            </p>
            <button type="button" class="spinroll-newsletter-done">Stäng</button>
        </section>
    `;
    document.body.appendChild(popup);

    const dialog = popup.querySelector(".spinroll-newsletter-dialog");
    const closeButton = popup.querySelector(".spinroll-newsletter-close");
    const doneButton = popup.querySelector(".spinroll-newsletter-done");
    let previouslyFocused = null;
    let awaitingResponse = false;
    let showing = false;

    function closePopup() {
        popup.hidden = true;
        showing = false;
        if (previouslyFocused && previouslyFocused.isConnected) {
            previouslyFocused.focus();
        }
    }

    function openPopup() {
        if (showing) return;
        showing = true;
        awaitingResponse = false;
        previouslyFocused = document.activeElement;
        popup.hidden = false;
        dialog.focus();
        form.reset();
        // Gör reCAPTCHA redo för nästa registrering.
        if (window.grecaptcha && typeof window.grecaptcha.reset === "function") {
            try { window.grecaptcha.reset(); } catch (error) { /* widgeten är inte laddad */ }
        }
    }

    closeButton.addEventListener("click", closePopup);
    doneButton.addEventListener("click", closePopup);
    popup.querySelector(".spinroll-newsletter-backdrop")
        .addEventListener("click", closePopup);

    document.addEventListener("keydown", event => {
        if (!showing) return;
        if (event.key === "Escape") closePopup();
        if (event.key === "Tab") {
            const focusables = [closeButton, doneButton];
            const index = focusables.indexOf(document.activeElement);
            if (event.shiftKey && index <= 0) {
                event.preventDefault();
                doneButton.focus();
            } else if (!event.shiftKey && index === focusables.length - 1) {
                event.preventDefault();
                closeButton.focus();
            }
        }
    });

    form.addEventListener("submit", () => {
        awaitingResponse = true;
    });

    // Brevos JS lägger till denna klass först när servern bekräftat
    // registreringen. Ett klick på knappen räcker alltså inte.
    const observer = new MutationObserver(() => {
        if (awaitingResponse &&
            successPanel.classList.contains("sib-form-message-panel--active")) {
            openPopup();
        }
    });
    observer.observe(successPanel, {
        attributes: true,
        attributeFilter: ["class", "style"],
        subtree: true
    });
});
