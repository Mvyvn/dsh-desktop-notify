// 对外 LED 控制 API —— 本分支专属的「串口控制协议」对外面（严格档）
//
// 其它插件经 `ctx.get('desktopNotify').led` 使用。硬件是 AI_Status_Lights
// （https://github.com/Mvyvn/AI_Status_Lights）：7 颗 WS2812B + 无源蜂鸣器，
// 线协议只有三条命令（验证 / 设 7 灯颜色 / 蜂鸣），见 led-protocol.ts。
//
// 设计原则与主线一致（见 api.ts 的版本约定）：
//   1. 未知字段一律忽略；非法**取值**一律拒绝并如实回报 reason，不猜意图；
//   2. 结果对象只增不改；
//   3. capabilities 让调用方探测能力，而不是靠版本号猜。
//
// 为什么不暴露"裸写字节"：裸字节能绕过 LEN/校验/命令白名单，把设备写进没人能复现的
// 状态。这里只放行真固件支持的三个 MODE，且载荷长度必须精确匹配。
import { LED_COUNT, MODE, PAYLOAD_LEN, encodeFrame, clampInt, } from './led-protocol.js';
import { LED_STATES, clampBrightness } from './led-scene.js';
/** 本分支的串口控制协议版本（与通知 API 版本分开标注）。 */
export const LED_API_VERSION = '1.1.0-led.3';
/** LED 能力清单（只增不减）。 */
export const LED_API_CAPABILITIES = [
    'led.protocol.aisl', // AI Status Lights 线协议（55 AA / MODE / 累加和 / BB）
    'led.pixels', // 7 颗灯的像素（主机渲染后推流）
    'led.scene', // 语义状态（运行中/等待你/已完成/警告/异常）
    'led.scene.warn', // 黄色警告状态（v1.1.0 新增；旧调用方不受影响）
    'led.brightness', // 亮度（主机端乘到通道上）
    'led.beep', // 无源蜂鸣器（频率/音量/时长）
    'led.frame', // 白名单原始帧（MODE 0x00/0x01/0x02）
    'led.ack', // 解除提醒闩
    'led.preview', // 手动点灯（诊断/bring-up）
    'led.status', // 链路与判定状态
    'led.host-only', // 宿主事件（会话/目标/团队/后台任务）才自动驱动灯；外部推送不点灯
];
function result(ok, queued, reason) {
    return { ok, queued, reason, protocolVersion: LED_API_VERSION };
}
/** 建对外 API。`port` 由 led-controller 注入（单测可传假实现）。 */
export function createLedApi(port) {
    // 请求本身合法（ok=true），只是没启用所以不入队（queued=false）——沿用 api.ts 的约定
    const disabled = () => (port.enabled() ? null : result(true, false, 'led-disabled'));
    return {
        version: LED_API_VERSION,
        capabilities: LED_API_CAPABILITIES,
        leds: LED_COUNT,
        scene(state, options = {}) {
            const block = disabled();
            if (block)
                return block;
            if (!LED_STATES.includes(state)) {
                return result(false, false, 'invalid-payload');
            }
            if (options.brightness !== undefined && !Number.isFinite(options.brightness)) {
                return result(false, false, 'invalid-payload');
            }
            const brightness = options.brightness === undefined
                ? undefined
                : clampBrightness(clampInt(Math.trunc(options.brightness), 0, 255));
            const queued = port.preview(state, brightness);
            return result(true, queued, queued ? '' : 'link-down');
        },
        beep(beep = {}) {
            const block = disabled();
            if (block)
                return block;
            for (const key of ['freqHz', 'volume', 'durationMs']) {
                const value = beep[key];
                if (value !== undefined && !Number.isFinite(value))
                    return result(false, false, 'invalid-payload');
            }
            const queued = port.beep(beep);
            return result(true, queued, queued ? '' : 'link-down');
        },
        pixels(list) {
            const block = disabled();
            if (block)
                return block;
            if (!Array.isArray(list) || list.length !== LED_COUNT)
                return result(false, false, 'invalid-payload');
            for (const px of list) {
                if (!px || typeof px !== 'object')
                    return result(false, false, 'invalid-payload');
                for (const ch of [px.r, px.g, px.b]) {
                    if (!Number.isFinite(ch) || ch < 0 || ch > 255)
                        return result(false, false, 'invalid-payload');
                }
            }
            const payload = [];
            for (const px of list)
                payload.push(Math.trunc(px.r), Math.trunc(px.g), Math.trunc(px.b));
            const queued = port.sendFrame(MODE.LEDS, payload);
            return result(true, queued, queued ? '' : 'link-down');
        },
        frame(mode, payload = []) {
            const block = disabled();
            if (block)
                return block;
            const expected = PAYLOAD_LEN[mode];
            if (expected === undefined)
                return result(false, false, 'unsupported-frame');
            if (!Array.isArray(payload) || payload.length !== expected)
                return result(false, false, 'invalid-payload');
            for (const byte of payload) {
                if (!Number.isFinite(byte) || byte < 0 || byte > 255)
                    return result(false, false, 'invalid-payload');
            }
            const queued = port.sendFrame(mode, payload.map((b) => Math.trunc(b)));
            return result(true, queued, queued ? '' : 'link-down');
        },
        acknowledge() {
            port.acknowledge();
        },
        status() {
            void encodeFrame; // 保持对外/对内编码同源；此处只是避免"未使用"告警
            return port.status();
        },
    };
}
