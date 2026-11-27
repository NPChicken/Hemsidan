// SpinRoll: official Instagram + TikTok 30-day posts -> Supabase timeline.
// Configure Cloudflare Cron Trigger (e.g. 0 */6 * * *), secrets and TikTok KV.
// No public HTTP endpoint, access tokens never leave Worker secrets/KV.
const SUPABASE_BASE = "https://bevemgjmcdkcbtsxezsa.supabase.co";
const LOOKBACK_MS = 30 * 86400000;
const safeText = value => String(value ?? "").trim().slice(0, 140);
const shortError = err => String(err?.message ?? err).slice(0, 360);
const cutoffTime = () => Date.now() - LOOKBACK_MS;

async function apiJson(url, options = {}) {
    const response = await fetch(url, { ...options, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error?.code || data.error?.message) {
        throw new Error("Social provider error, HTTP " + response.status +
            ": " + JSON.stringify(data.error || {}).slice(0, 220));
    }
    return data;
}

async function supabaseRequest(path, env, method = "GET", data) {
    const url = SUPABASE_BASE + "/rest/v1/" + path;
    const response = await fetch(url, {
        method,
        headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=minimal"
        },
        body: data === undefined ? undefined : JSON.stringify(data)
    });
    if (!response.ok) {
        throw new Error("Supabase sync HTTP " + response.status +
            ": " + (await response.text()).slice(0, 200));
    }
}

async function savePosts(channel, posts, env) {
    if (!posts.length) return;
    // The unique source/id pair makes repeated syncs idempotent.
    await supabaseRequest("marketing_posts?on_conflict=source,external_id", env,
        "POST", posts.map(p => ({
            source: channel,
            external_id: p.id,
            channel,
            title: p.title || channel,
            published_at: p.published,
            post_url: p.url,
            created_by: null
        })));
}

async function updateStatus(channel, env, error, count = 0) {
    const status = error
        ? { channel, last_error_at: new Date().toISOString(), error_message: shortError(error) }
        : { channel, last_success_at: new Date().toISOString(), error_message: null, posts_seen: count };
    await supabaseRequest("social_sync_status?on_conflict=channel", env, "POST", [status]);
}

async function instagramPosts(env) {
    if (!env.INSTAGRAM_ACCESS_TOKEN) throw new Error("Instagram has not been connected");
    const token = env.INSTAGRAM_ACCESS_TOKEN;
    const account = await apiJson("https://graph.instagram.com/me?fields=id,username&access_token=" +
        encodeURIComponent(token));
    if (String(account.username || "").toLowerCase() !== "spinrolluf") {
        throw new Error("Instagram token belongs to a different account");
    }
    let pageUrl = "https://graph.instagram.com/me/media?fields=id,permalink,timestamp" +
        "&limit=100&access_token=" + encodeURIComponent(token);
    const posts = [], seen = new Set();
    for (let page = 0; page < 10 && pageUrl; page++) {
        const data = await apiJson(pageUrl);
        let oldest = Infinity;
        for (const item of data.data || []) {
            if (!item.id || !item.timestamp) continue;
            const ms = Date.parse(item.timestamp);
            if (!Number.isFinite(ms)) continue;
            oldest = Math.min(oldest, ms);
            if (ms < cutoffTime() || ms > Date.now() || seen.has(item.id)) continue;
            seen.add(item.id);
            posts.push({
                id: String(item.id),
                title: "Instagram-inlägg",
                published: new Date(ms).toISOString(),
                url: typeof item.permalink === "string" &&
                    item.permalink.startsWith("https://www.instagram.com/")
                    ? item.permalink : null
            });
        }
        pageUrl = oldest < cutoffTime() ? null : data.paging?.next || null;
        if (pageUrl && !pageUrl.startsWith("https://graph.instagram.com/")) {
            throw new Error("Invalid Instagram pagination host");
        }
    }
    return posts;
}

async function tiktokAccess(env) {
    if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET ||
        !env.SOCIAL_TOKENS) {
        throw new Error("TikTok OAuth credentials or SOCIAL_TOKENS KV missing");
    }
    // TikTok refresh tokens rotate. Persist the replacement in a private KV.
    const refresh = await env.SOCIAL_TOKENS.get("tiktok_refresh") ||
        env.TIKTOK_INITIAL_REFRESH_TOKEN;
    if (!refresh) throw new Error("TikTok account has not been authorized");
    const params = new URLSearchParams({
        client_key: env.TIKTOK_CLIENT_KEY,
        client_secret: env.TIKTOK_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refresh
    });
    const result = await apiJson("https://open.tiktokapis.com/v2/oauth/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params
    });
    if (!result.access_token || !result.refresh_token) {
        throw new Error("TikTok token refresh did not return credentials");
    }
    await env.SOCIAL_TOKENS.put("tiktok_refresh", result.refresh_token);
    return result.access_token;
}

async function tiktokPosts(env) {
    const token = await tiktokAccess(env);
    const account = await apiJson(
        "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
        { headers: { Authorization: "Bearer " + token } });
    if (env.TIKTOK_EXPECTED_OPEN_ID &&
        account.data?.user?.open_id !== env.TIKTOK_EXPECTED_OPEN_ID) {
        throw new Error("TikTok token belongs to a different account");
    }
    const posts = [], seen = new Set();
    let cursor;
    for (let page = 0; page < 20; page++) {
        const body = { max_count: 20 };
        if (cursor != null) body.cursor = cursor;
        const data = await apiJson(
            "https://open.tiktokapis.com/v2/video/list/?fields=id,create_time,title,share_url",
            {
                method: "POST",
                headers: { Authorization: "Bearer " + token,
                    "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
        const videos = data.data?.videos || [];
        let oldest = Infinity;
        for (const video of videos) {
            const ms = Number(video.create_time) * 1000;
            if (!Number.isFinite(ms) || !video.id) continue;
            oldest = Math.min(oldest, ms);
            if (ms < cutoffTime() || ms > Date.now() || seen.has(video.id)) continue;
            seen.add(video.id);
            posts.push({
                id: String(video.id),
                title: safeText(video.title) || "TikTok-video",
                published: new Date(ms).toISOString(),
                url: typeof video.share_url === "string" &&
                    video.share_url.startsWith("https://www.tiktok.com/")
                    ? video.share_url : null
            });
        }
        if (!data.data?.has_more || !videos.length || oldest < cutoffTime()) break;
        if (data.data.cursor == null || data.data.cursor === cursor) break;
        cursor = data.data.cursor;
    }
    return posts;
}

async function runSync(env) {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase secret missing");
    for (const [channel, load] of [
        ["instagram", instagramPosts],
        ["tiktok", tiktokPosts]
    ]) {
        try {
            const posts = await load(env);
            await savePosts(channel, posts, env);
            await updateStatus(channel, env, null, posts.length);
            console.log(channel + " synced", posts.length);
        } catch (err) {
            console.error(channel + " sync failed:", shortError(err));
            await updateStatus(channel, env, err);
        }
    }
}

export default {
    // No publicly accessible synchronization or secret inspection endpoint.
    fetch() { return new Response("Not found", { status: 404 }); },
    async scheduled(event, env, ctx) { ctx.waitUntil(runSync(env)); }
};
