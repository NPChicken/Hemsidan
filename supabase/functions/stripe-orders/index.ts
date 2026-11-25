// SpinRoll UF – Stripe Checkout -> Supabase, enbart TESTLÄGE.
// Stripe signerar inkommande webhookar. Inga nycklar lagras i GitHub.
// Lägg in STRIPE_API_KEY (sk_test_...) och STRIPE_WEBHOOK_SIGNING_SECRET (whsec_...)
// under Supabase Edge Functions > Secrets. Function måste ha verify_jwt = false.
import Stripe from "npm:stripe@^22";
import { withSupabase } from "npm:@supabase/server@^1";

const apiKey = Deno.env.get("STRIPE_API_KEY");
const signingSecret = Deno.env.get("STRIPE_WEBHOOK_SIGNING_SECRET");
if (!apiKey?.startsWith("sk_test_")) {
  throw new Error("STRIPE_API_KEY måste vara en Stripe-testnyckel.");
}
if (!signingSecret?.startsWith("whsec_")) {
  throw new Error("STRIPE_WEBHOOK_SIGNING_SECRET saknas eller är ogiltig.");
}

const stripe = new Stripe(apiKey);
const cryptoProvider = Stripe.createSubtleCryptoProvider();

async function lineItemsForSession(sessionId: string) {
  const items: Stripe.LineItem[] = [];
  let startingAfter: string | undefined;
  do {
    const page = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    items.push(...page.data);
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
    if (page.has_more && !startingAfter) throw new Error("Kunde inte läsa alla orderrader.");
  } while (startingAfter);
  return items;
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const signature = req.headers.get("stripe-signature");
    if (!signature) return new Response("Missing signature", { status: 400 });

    // Signaturen verifieras mot oförändrad råtext, innan någon data används.
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(
        await req.text(),
        signature,
        signingSecret,
        undefined,
        cryptoProvider,
      );
    } catch (error) {
      console.error("Stripe webhook: signaturen kunde inte verifieras.", error);
      return new Response("Invalid signature", { status: 400 });
    }

    if (event.type !== "checkout.session.completed" &&
        event.type !== "checkout.session.async_payment_succeeded") {
      return Response.json({ received: true, ignored: true });
    }

    // En skarp betalning ska ALDRIG behandlas av denna testintegration.
    if (event.livemode) return new Response("Live events are not accepted", { status: 400 });

    try {
      const eventSession = event.data.object as Stripe.Checkout.Session;
      // Hämta färska serververifierade uppgifter, lita inte på klientens kundvagn.
      const session = await stripe.checkout.sessions.retrieve(eventSession.id);
      if (session.livemode || session.mode !== "payment") {
        return new Response("Wrong Stripe mode", { status: 400 });
      }
      if (session.payment_status !== "paid") {
        return Response.json({ received: true, status: "awaiting_payment" });
      }
      if (session.amount_total == null || !session.currency) {
        throw new Error("Betald Checkout Session saknar belopp eller valuta.");
      }

      const shipping = session.collected_information?.shipping_details;
      const address = shipping?.address;
      const customer = session.customer_details;

      const order = {
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: typeof session.payment_intent === "string"
          ? session.payment_intent : session.payment_intent?.id ?? null,
        stripe_mode: "test",
        customer_name: customer?.name ?? null,
        customer_email: customer?.email ?? session.customer_email ?? null,
        shipping_name: shipping?.name ?? null,
        shipping_address_line1: address?.line1 ?? null,
        shipping_address_line2: address?.line2 ?? null,
        shipping_postal_code: address?.postal_code ?? null,
        shipping_city: address?.city ?? null,
        shipping_country: address?.country ?? null,
        currency: session.currency,
        amount_total: session.amount_total,
        payment_status: "paid",
        stripe_created_at: new Date(session.created * 1000).toISOString(),
      };

      // UNIQUE stripe_checkout_session_id gör omlevererade webhooks idempotenta.
      // Vi uppdaterar inte fulfillment_status vid återleverans.
      let orderId: string;
      const inserted = await ctx.supabaseAdmin
        .from("orders").insert(order).select("id").single();
      if (!inserted.error && inserted.data) {
        orderId = inserted.data.id;
      } else if (inserted.error?.code === "23505") {
        const existing = await ctx.supabaseAdmin.from("orders")
          .select("id").eq("stripe_checkout_session_id", session.id).single();
        if (existing.error || !existing.data) throw existing.error ?? new Error("Order saknas.");
        orderId = existing.data.id;
      } else {
        throw inserted.error ?? new Error("Kunde inte skapa order.");
      }

      // Separat upsert gör återförsök säkra även om ett tidigare anrop avbröts
      // efter att orderhuvudet hade sparats.
      const lines = await lineItemsForSession(session.id);
      if (!lines.length) throw new Error("Checkout Session saknar orderrader.");

      const rows = lines.map((item, index) => ({
        order_id: orderId,
        line_no: index + 1,
        product_name: item.description || "Produkt",
        product_reference: item.price?.id ?? null,
        quantity: Math.max(1, item.quantity ?? 1),
        unit_amount: item.price?.unit_amount ??
          Math.round((item.amount_subtotal ?? item.amount_total) / Math.max(1, item.quantity ?? 1)),
        currency: session.currency,
      }));

      const { error: itemError } = await ctx.supabaseAdmin
        .from("order_items").upsert(rows, { onConflict: "order_id,line_no" });
      if (itemError) throw itemError;

      // Undvik att skriva ut kunduppgifter i serverloggar.
      console.log("Stripe testorder registrerad:", session.id);
      return Response.json({ received: true });
    } catch (error) {
      console.error("Stripe webhook: orderregistrering misslyckades:", error);
      // 500 gör att Stripe kan försöka leverera händelsen igen.
      return new Response("Order processing failed", { status: 500 });
    }
  }),
};
