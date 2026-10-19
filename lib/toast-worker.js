// Windows Toast 发送 worker —— 把**同步 COM 调用**从宿主主线程彻底挪走。
//
// 背景（审计 #4）：WinRT 的 RoActivateInstance / LoadXml / Show 都是同步 koffi 调用，
// 实测单条可 >100ms。留在主线程时，一条通知的发送会顶住事件循环：心跳、SSE、
// 灯采样、UI 都可能被推迟。这里把 winrt.js 放进独立 worker（与 serial/led worker
// 同一模式），主线程只 postMessage。
//
// 失败策略：worker 自己只上报错误；**回退 inline 由主线程的 toast-bridge 决定**
// （probe 失败/线程退出/回执超时时回退，保证通知不静默丢失）。
import { parentPort } from 'node:worker_threads';
import * as winrt from './winrt.js';
/** 主线程注册过 `dsh-notify:` 协议吗？（决定点击走协议还是浏览器落地页） */
let protocolReady = false;
function post(msg) {
    try {
        parentPort?.postMessage(msg);
    }
    catch (e) { /* 主线程没了 */ }
}
parentPort?.on('message', (msg) => {
    if (!msg || typeof msg.t !== 'string')
        return;
    if (msg.t === 'clickProtocol') {
        protocolReady = msg.ready === true;
        winrt.syncClickProtocol(protocolReady);
        return;
    }
    if (msg.t === 'probe') {
        // 只初始化 WinRT + 建 notifier，**不发通知**（不会打扰用户）
        const result = winrt.probeBackend();
        if (result.ok)
            winrt.syncClickProtocol(protocolReady);
        post({ t: 'probe-reply', id: msg.id, ok: result.ok, message: result.ok ? '' : (result.message || 'probe failed') });
        return;
    }
    if (msg.t === 'toast') {
        try {
            winrt.sendToast(msg.item);
            post({ t: 'sent', id: msg.id });
        }
        catch (e) {
            post({ t: 'error', id: msg.id, message: (e && e.message) ? e.message : String(e) });
        }
        return;
    }
    if (msg.t === 'shutdown') {
        // 直接退出：worker 里没有需要落盘的状态（通知已同步 Show 完）
        process.exit(0);
    }
});
post({ t: 'ready' });
