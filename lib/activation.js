// 激活决策 — 把一次点击解析成**互斥且可证明**的四种结果
//
// 用户需求是确定性的三态，这里把它落成一个纯函数，宿主只负责执行：
//   点击目标为空                → ignore     （什么都不做）
//   有目标 + 有可投递的 DSH 页面 → deliver    （只让那个页面跳转）
//   有目标 + 没有 DSH 页面      → open-app   （新开 DSH 并带 hash 深链跳转）
//   有目标是外部 URL            → open-url   （交给系统/浏览器打开，与 DSH 无关）
//
// 关键点：**决策发生在打开任何窗口之前**。
//   · Windows：Toast 走自定义协议 `dsh-notify:` → 本机转发器 → POST /dnotify/activate
//     → 宿主在这里决策，只有 open-app/open-url 才会真的拉起浏览器（deliver 不产生任何窗口）。
//   · Linux：D-Bus ActionInvoked 直接在宿主进程里决策，open-* 时才调 portal。
// 这样"已打开 DSH 页面时新开标签页"这条老问题就从架构上消失了。
import { needsDshPage } from './protocol.js';
import { pickDeliveryPage } from './pages.js';
/** 计算执行计划；纯函数，不做 I/O。 */
export function planActivation(target, ctx) {
    if (target.type === 'none')
        return { action: 'ignore', reason: 'no-target' };
    if (target.type === 'url')
        return { action: 'open-url', url: target.url };
    // session / page：需要 DSH 页面
    const page = pickDeliveryPage(ctx.registry, ctx.now);
    if (page !== undefined)
        return { action: 'deliver', pageId: page.pageId, page };
    return { action: 'open-app', url: ctx.appUrl(target) };
}
/** 该计划是否需要"打开浏览器/外部程序"（用于日志与测试断言）。 */
export function planOpensWindow(plan) {
    return plan.action === 'open-app' || plan.action === 'open-url';
}
/** 该计划是否需要 DSH 应用页面（用于把非法目标挡在前面）。 */
export function targetNeedsApp(target) {
    return needsDshPage(target);
}
