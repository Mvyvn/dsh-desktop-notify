// 聚焦门控 — 纯逻辑状态机（无宿主依赖，便于单测）
//
// 语义：只有"你正在看的那个会话"才静默——浏览器半区为每个页面上报
// {聚焦状态, 当前选中的会话 id}，宿主据此判定某条通知是否该被静默。
//   · 页面聚焦 + 该页面选中的会话 ∈ 通知所属会话 → 静默
//   · 通知未携带会话 id（归属不明）→ 不静默，照常推送
//   · 无聚焦页面 / 聚焦静止超时 → 推送
//
// 注意：门控只决定"要不要弹"，与"点击跳到哪里"完全无关（后者见 protocol.ts / activation.ts）。
/** 聚焦"保鲜"时长：聚焦页面超过此时长没有活动上报，视为已失焦（2 分钟）。 */
export const FOCUS_STALE_MS = 120_000;
/** 页面条目存活时长：超过此时长没有任何上报的页面条目被清理（异常关闭兜底，10 分钟）。 */
export const PAGE_STALE_MS = 600_000;
/**
 * 归一"通知所属会话"：接受会话对象（取 .id）、字符串 id、或它们的数组。
 * @returns 去重后的非空字符串 id
 */
export function sessionIdList(input) {
    const out = [];
    const push = (value) => {
        if (value === undefined || value === null)
            return;
        if (typeof value === 'object') {
            const id = value.id;
            if (id !== undefined && id !== null)
                push(id);
            return;
        }
        const text = String(value);
        if (text !== '' && !out.includes(text))
            out.push(text);
    };
    if (Array.isArray(input)) {
        for (const value of input)
            push(value);
    }
    else {
        push(input);
    }
    return out;
}
export function createFocusGate(options = {}) {
    const focusStaleMs = options.focusStaleMs ?? FOCUS_STALE_MS;
    const pageStaleMs = options.pageStaleMs ?? PAGE_STALE_MS;
    const pages = new Map();
    const setPage = (pageId, at, sessionId) => {
        const key = String(pageId);
        const session = sessionId === undefined || sessionId === null ? '' : String(sessionId);
        pages.set(key, { at, sessionId: session });
    };
    const clearPage = (pageId) => {
        pages.delete(String(pageId));
    };
    const prune = (now) => {
        for (const [id, record] of [...pages]) {
            if (now - record.at > pageStaleMs)
                pages.delete(id);
        }
    };
    const silenced = (sessionIds, now) => {
        prune(now);
        if (!Array.isArray(sessionIds) || sessionIds.length === 0)
            return false;
        for (const record of pages.values()) {
            if (now - record.at >= focusStaleMs)
                continue;
            if (record.sessionId !== '' && sessionIds.includes(record.sessionId))
                return true;
        }
        return false;
    };
    return {
        setPage,
        clearPage,
        prune,
        silenced,
        get size() {
            return pages.size;
        },
    };
}
