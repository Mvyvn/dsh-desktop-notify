// 点击协议 — ClickTarget 四态 + 线格式编解码（纯函数，无副作用）
//
// 设计要点（对应"点击不跳转 / 有页面跳转 / 无页面新开"三态需求的第 0 层）：
//   · 点击目标**显式建模**，不再靠"url 是不是空"或"有没有 sessionId"推断语义；
//   · `sessionId` 只用于聚焦门控（防打扰），点击行为一律由这里决定；
//   · 线格式保持与旧版兼容：session:<id> / page:<名字>，新增 url:<encoded> 与 none。
//
// 四态：
//   none                        → 不可点击：不跳转（配置留空就是这个）
//   session:<会话 id>            → 跳到该会话（需要 DSH 页面；没有就新开）
//   page:settings-plugins|plugins → 跳到 DSH 的某个内置页面（同上）
//   url:<http(s) 地址>           → 打开外部地址（与 DSH 页面无关，永远交给系统/浏览器）
/** 不可点击（默认值）。 */
export function clickNone() {
    return { type: 'none' };
}
/** 跳到某个会话。 */
export function clickSession(sessionId) {
    return { type: 'session', sessionId };
}
/** 跳到 DSH 的内置页面。 */
export function clickPage(page) {
    return { type: 'page', page };
}
/** 打开外部地址；只接受 http/https 且长度合理，其它一律返回 null。 */
export function clickUrl(raw) {
    const url = String(raw).trim();
    if (url.length === 0 || url.length > 2048)
        return null;
    // 只判断协议前缀不够：`http://`、`https://not a url`、`https://[invalid` 都能过正则，
    // 最后变成"通知可点击但系统打不开"。用 URL 解析 + 协议白名单 + 主机名非空。
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch (e) {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return null;
    if (!parsed.hostname)
        return null;
    // 注意：校验用解析结果，**返回原串**——normalize 会补尾斜杠，改变既有线格式。
    return { type: 'url', url };
}
/** 该目标是否需要 DSH 页面（none/url 不需要）。 */
export function needsDshPage(target) {
    return target.type === 'session' || target.type === 'page';
}
/**
 * 把点击目标编码成线格式（出现在通知 URL、hash 深链、激活端点里）。
 * @returns 形如 `none` / `session:<id>` / `page:<name>` / `url:<encodeURIComponent>`
 */
export function encodeClickTarget(target) {
    switch (target.type) {
        case 'none':
            return 'none';
        case 'session':
            return `session:${target.sessionId}`;
        case 'page':
            return `page:${target.page}`;
        case 'url':
            return `url:${encodeURIComponent(target.url)}`;
    }
}
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const PAGE_TARGETS = ['settings-plugins', 'plugins'];
/**
 * 解析线格式；不认识的一律返回 null（调用方据此判非法，**不猜测**）。
 * 空串按 none 处理：历史链接可能没带 target。
 */
export function decodeClickTarget(raw) {
    const text = raw.trim();
    if (text.length === 0 || text === 'none')
        return { type: 'none' };
    if (text.startsWith('session:')) {
        const sessionId = text.slice('session:'.length);
        return SESSION_ID_RE.test(sessionId) ? { type: 'session', sessionId } : null;
    }
    if (text.startsWith('page:')) {
        const page = text.slice('page:'.length);
        return PAGE_TARGETS.includes(page) ? { type: 'page', page: page } : null;
    }
    if (text.startsWith('url:')) {
        let decoded = '';
        try {
            decoded = decodeURIComponent(text.slice('url:'.length));
        }
        catch {
            return null;
        }
        return clickUrl(decoded);
    }
    return null;
}
/** 通知点击地址里的 query 片段：`raw=<线格式>`（已编码）。 */
export function activateQuery(target) {
    return `raw=${encodeURIComponent(encodeClickTarget(target))}`;
}
