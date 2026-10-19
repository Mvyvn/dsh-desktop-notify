// 主机端渲染器 —— 语义画面 + 时间 → 7 颗 WS2812B 的像素
//
// 为什么动画在主机：真固件（AI_Status_Lights）只有"设 7 颗灯颜色"和"蜂鸣"两条命令，
// 没有任何本地动画/亮度/覆盖层概念。所以主机每帧算好像素再推（26 字节，30fps ≈ 780 B/s，
// 115200 只占 ~7%）。好处是改个动画不用重烧固件；代价是主机卡顿时灯会顿一下
// （串口链路层做了"帧没变就不发"和断线重连，卡顿不会累积）。
//
// 纯函数：同样的 (画面, 时刻) 一定得到同样的像素 —— 单测直接按时刻断言。
import { LED_COUNT, clampByte, scaleColor } from './led-protocol.js';
import { SCENE_FLAG } from './led-scene.js';
/** 语义状态的主色（RGB）。 */
export const STATE_COLOR = {
    running: { r: 0xc8, g: 0xd2, b: 0xe0 }, // 冷白：在干活
    // 更橙的琥珀：与"警告黄"拉开色差（旧 #ffa000 偏黄，二者在小灯上容易混）
    waiting: { r: 0xff, g: 0x88, b: 0x00 },
    done: { r: 0x00, g: 0xc8, b: 0x53 }, // 绿：完成
    error: { r: 0xff, g: 0x00, b: 0x00 }, // **纯红**：之前的 #FF1744 偏粉（看起来像玫红）
    // 黄：介于"红"与"橙呼吸"之间（用户指定的第三档）。只有 2 秒的瞬态警告事件用它。
    warn: { r: 0xff, g: 0xd0, b: 0x00 },
    off: { r: 0, g: 0, b: 0 },
};
/**
 * 运行中的"彗星"速度（毫秒/灯位）。
 * 基数 170ms/灯位；整体**加快 3%** → 165.05ms/灯位（一趟约 0.99s）。
 * 单摆曲线本身的端点速度为 0（折返不闪），不再额外加"两端减速"。
 */
const COMET_MS_PER_LED = 170 / 1.03;
/** 提醒（自上次聚焦未回来）时的双闪周期。 */
const ALERT_PERIOD_MS = 1600;
const ALERT_ON_MS = 110;
const ALERT_GAP_MS = 110;
const BLACK = { r: 0, g: 0, b: 0 };
/** 取第 i 颗灯的可写像素（缓冲不足时补一个；正常路径是预分配好的）。 */
function pixelAt(out, i) {
    const px = out[i];
    if (px !== undefined)
        return px;
    const created = { r: 0, g: 0, b: 0 };
    out[i] = created;
    return created;
}
/**
 * 写入"颜色 × 强度 × 亮度"。
 *
 * ⚠️ 两次取整的顺序不能改：旧实现是 `dim()` 先四舍五入、`scaleColor()` 再四舍五入。
 * 合并成一次乘会让低亮度下的通道值差 1（逐字节对拍会红），所以这里保留两次取整。
 */
function writeScaled(px, color, k, level) {
    const f = clamp01(k);
    px.r = Math.round(Math.round(color.r * f) * level / 255);
    px.g = Math.round(Math.round(color.g * f) * level / 255);
    px.b = Math.round(Math.round(color.b * f) * level / 255);
}
/** 写入全黑（0,0,0）。 */
function writeBlack(px) {
    px.r = 0;
    px.g = 0;
    px.b = 0;
}
function clamp01(x) {
    if (!Number.isFinite(x))
        return 0;
    if (x < 0)
        return 0;
    if (x > 1)
        return 1;
    return x;
}
/**
 * 提醒包络：周期内两个 "滴滴" 亮块（各自 110ms）。
 *
 * ⚠️ 亮块两端必须有**短渐变**（25ms），不能是方波：
 * 方波在熄灭/被确认时可能正好停在"亮到一半/暗到一半"，下一帧直接切到常亮色，
 * 看起来就是一次没做完的闪。这里让每个亮块自带上升/下降沿，再配合链路从**当前像素**
 * 起交叉渐变，任何时刻中断都能平滑衔接。
 */
const ALERT_RAMP_MS = 25;
function alertPulse(t, start) {
    const local = t - start;
    if (local <= 0 || local >= ALERT_ON_MS)
        return 0;
    return clamp01(Math.min(local, ALERT_ON_MS - local) / ALERT_RAMP_MS);
}
export function alertEnvelope(nowMs) {
    const t = ((nowMs % ALERT_PERIOD_MS) + ALERT_PERIOD_MS) % ALERT_PERIOD_MS;
    return Math.max(alertPulse(t, 0), alertPulse(t, ALERT_ON_MS + ALERT_GAP_MS));
}
/** 平滑呼吸：0..1（周期 2.4s）。 */
export function breathe(nowMs, periodMs = 2400) {
    const phase = (nowMs % periodMs) / periodMs;
    return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2); // 0 → 1 → 0
}
/** ease-in-out（三次）：渐变的"曲速"感就靠它，线性看起来会发硬。 */
export function smootherstep(k) {
    const t = clamp01(k);
    return t * t * t * (t * (t * 6 - 15) + 10);
}
/** HSV → RGB（自检彩虹用；h 0..360、s/v 0..1）。 */
export function hsvToRgb(h, s, v) {
    const hh = ((h % 360) + 360) % 360;
    const c = clamp01(v) * clamp01(s);
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = clamp01(v) - c;
    let r = 0;
    let g = 0;
    let b = 0;
    if (hh < 60) {
        r = c;
        g = x;
    }
    else if (hh < 120) {
        r = x;
        g = c;
    }
    else if (hh < 180) {
        g = c;
        b = x;
    }
    else if (hh < 240) {
        g = x;
        b = c;
    }
    else if (hh < 300) {
        r = x;
        b = c;
    }
    else {
        r = c;
        b = x;
    }
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
export const SWEEP_MS = 1333; // 1600 ÷ 1.2：自检彩虹流转速度 ×1.2
export function renderSelfTest(nowMs, startedAt, result, totalMs = 2000, brightness = 255) {
    const t = Math.max(0, nowMs - startedAt);
    // 自检动画同样受**亮度百分比**控制（与常规画面走同一个 gamma 映射）
    const level = Math.round(255 * Math.pow(clamp01(brightness / 255), 2));
    const color = result === 'ok' ? STATE_COLOR.done : result === 'degraded' ? STATE_COLOR.waiting : STATE_COLOR.error;
    const out = [];
    if (t <= SWEEP_MS) {
        const fade = clamp01(t / 100);
        const sweep = t / SWEEP_MS;
        for (let i = 0; i < LED_COUNT; i += 1) {
            // 色相 = 位置 + 时间：一条从左往右流淌的彩虹；用满亮度，别被淡入压低
            const hue = (i / LED_COUNT) * 360 + sweep * 720;
            out.push(scaleColor(hsvToRgb(hue, 0.95, 1), level));
        }
        void fade;
        return out;
    }
    if (t >= totalMs)
        return Array.from({ length: LED_COUNT }, () => BLACK);
    // 结果色**保持到最后一帧**：之前末段自己先淡到黑，交接时看起来"结果色没效果"，
    // 然后真实画面又整段亮起来，像闪了一下。交接收尾交给 link.restartFade()。
    for (let i = 0; i < LED_COUNT; i += 1)
        out.push(scaleColor(color, level));
    return out;
}
export function easeInOut(k) {
    const f = clamp01(k);
    return f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
}
/**
 * 两帧像素按 k（0=全 a，1=全 b）混合 —— **在 OKLab 里插值**。
 *
 * 为什么不在 sRGB 里直接 lerp：sRGB 的 8 位值不是感知均匀的，红→绿直接平均会经过
 * 一段发灰的浑浊色；OKLab 是感知均匀空间，插值出来的中间色看起来"就是那两个颜色之间的
 * 那个颜色"。对 7 颗灯的交叉渐变，这是观感差别最大的一步。
 *
 * in-place 版本（帧循环用）：`out` 可以是预分配缓冲，也可以与 `a`/`b` 同一块内存
 * （逐像素读→写，没有跨像素依赖）。
 */
export function blendPixelsInto(out, a, b, k) {
    const f = clamp01(k);
    for (let i = 0; i < LED_COUNT; i += 1) {
        const pa = a[i] ?? BLACK;
        const pb = b[i] ?? BLACK;
        const px = pixelAt(out, i);
        if (f <= 0) {
            px.r = pa.r;
            px.g = pa.g;
            px.b = pa.b;
            continue;
        }
        if (f >= 1) {
            px.r = pb.r;
            px.g = pb.g;
            px.b = pb.b;
            continue;
        }
        // 下面是与 srgbToOklab/oklabToSrgb **同一套公式的标量版**（不建中间对象）
        const ar = toLinear(pa.r);
        const ag = toLinear(pa.g);
        const ab = toLinear(pa.b);
        const br = toLinear(pb.r);
        const bg = toLinear(pb.g);
        const bb = toLinear(pb.b);
        const l1 = Math.cbrt(0.4122214708 * ar + 0.5363325363 * ag + 0.0514459929 * ab);
        const m1 = Math.cbrt(0.2119034982 * ar + 0.6806995451 * ag + 0.1073969566 * ab);
        const s1 = Math.cbrt(0.0883024619 * ar + 0.2817188376 * ag + 0.6299787005 * ab);
        const l2 = Math.cbrt(0.4122214708 * br + 0.5363325363 * bg + 0.0514459929 * bb);
        const m2 = Math.cbrt(0.2119034982 * br + 0.6806995451 * bg + 0.1073969566 * bb);
        const s2 = Math.cbrt(0.0883024619 * br + 0.2817188376 * bg + 0.6299787005 * bb);
        const caL = 0.2104542553 * l1 + 0.7936177850 * m1 - 0.0040720468 * s1;
        const caA = 1.9779984951 * l1 - 2.4285922050 * m1 + 0.4505937099 * s1;
        const caB = 0.0259040371 * l1 + 0.7827717662 * m1 - 0.8086757660 * s1;
        const cbL = 0.2104542553 * l2 + 0.7936177850 * m2 - 0.0040720468 * s2;
        const cbA = 1.9779984951 * l2 - 2.4285922050 * m2 + 0.4505937099 * s2;
        const cbB = 0.0259040371 * l2 + 0.7827717662 * m2 - 0.8086757660 * s2;
        const L = caL + (cbL - caL) * f;
        const A = caA + (cbA - caA) * f;
        const B = caB + (cbB - caB) * f;
        const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
        const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
        const s_ = L - 0.0894841775 * A - 1.2914855480 * B;
        const l = l_ * l_ * l_;
        const m = m_ * m_ * m_;
        const s = s_ * s_ * s_;
        const mr = toSrgbByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
        const mg = toSrgbByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
        const mb = toSrgbByte(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
        // **逐通道夹在两端点之间**：OKLab 的逆变换会轻微越界，
        // 不夹的话渐变中会出现"比两端都亮"的瞬间（用户看到的就是"亮度先冲高再落下来"）。
        px.r = clampBetween(mr, pa.r, pb.r);
        px.g = clampBetween(mg, pa.g, pb.g);
        px.b = clampBetween(mb, pa.b, pb.b);
    }
    return out;
}
/** 纯函数版本（一次性调用/单测用；每帧都调的地方请用 in-place 入口）。 */
export function blendPixels(a, b, k) {
    return blendPixelsInto([], a, b, k);
}
/** 把 x 夹到 a、b 之间（a/b 无序）。 */
function clampBetween(x, a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return Math.max(lo, Math.min(hi, Math.round(x)));
}
const toLinear = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const toSrgbByte = (x) => {
    const c = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
};
export function srgbToOklab(c) {
    const r = toLinear(c.r);
    const g = toLinear(c.g);
    const b = toLinear(c.b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {
        L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    };
}
export function oklabToSrgb(c) {
    const l_ = c.L + 0.3963377774 * c.a + 0.2158037573 * c.b;
    const m_ = c.L - 0.1055613458 * c.a - 0.0638541728 * c.b;
    const s_ = c.L - 0.0894841775 * c.a - 1.2914855480 * c.b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    return {
        r: toSrgbByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        g: toSrgbByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        b: toSrgbByte(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    };
}
/** 时间抖动：8 位通道在低亮度只有几个台阶，按帧交替 ±1 LSB 能把"台阶"铺成连续亮度。 */
export function ditherPixelsInto(out, frame) {
    for (let i = 0; i < out.length; i += 1) {
        const px = out[i];
        if (px === undefined)
            continue;
        px.r = clampByte(px.r + (((frame + i) % 2 === 0) ? 1 : 0));
        px.g = clampByte(px.g + (((frame + i) % 2 === 1) ? 1 : 0));
        px.b = clampByte(px.b);
    }
    return out;
}
/** 纯函数版本（拷贝一份再抖动，不改入参）。 */
export function ditherPixels(pixels, frame) {
    return ditherPixelsInto(pixels.map((px) => ({ r: px.r, g: px.g, b: px.b })), frame);
}
/**
 * 渲染一帧像素（**写入预分配的 out**，帧循环用）。
 *
 * 语义与旧纯函数完全一致（逐字节对拍见 tests/led-render.test.mjs）：
 * 同样的 (画面, 时刻) 一定写进同样的 7 颗灯。
 *
 * @param out 可写像素缓冲（至少 LED_COUNT 项；不足会补，多余项不动）
 * @param scene 语义画面（judge 产出）
 * @param nowMs 单调时钟（毫秒）
 * @param ageMs 画面出现了多久（running 的流转相位锚点；默认未知 = 用绝对时刻）
 */
export function renderPixelsInto(out, scene, nowMs, ageMs = Number.POSITIVE_INFINITY) {
    const base = STATE_COLOR[scene.state] ?? BLACK;
    const brightness = scene.state === 'off' ? 0 : scene.brightness;
    if (brightness <= 0) {
        for (let i = 0; i < LED_COUNT; i += 1)
            writeBlack(pixelAt(out, i));
        return out;
    }
    // 夜间再暗一档
    const nightK = (scene.flags & SCENE_FLAG.NIGHT) !== 0 ? 0.5 : 1;
    // **亮度做感知（gamma）映射**：线性亮度在低端看起来是"啪一下亮起来"，
    // 加上 gamma≈2 之后 8 位通道的低端台阶被拉开，渐变看起来才顺。
    const linear = clamp01((brightness * nightK) / 255);
    const level = Math.round(255 * Math.pow(linear, 2));
    const alerting = (scene.flags & SCENE_FLAG.ATTENTION) !== 0;
    const muted = (scene.flags & SCENE_FLAG.MUTED) !== 0;
    switch (scene.state) {
        case 'running': {
            // 流转（左右往返）—— 三条硬规则，都是踩过的坑：
            //  1) **相位锚定在"这个画面出现多久"**（ageMs），不再用绝对时间：
            //     否则插件启动时相位是随机的，光斑会从**中间**冒出来而不是从左边切入。
            //  2) **不要镜面/环绕补光**：两者都会在端点额外加光，把亮度重心往回拽
            //     （实测表现为"到边缘先回抖一下再折返"）。
            //  3) 光斑近似对称、只带一点点前导：重心基本跟着头部走，折返处不抖。
            const N = LED_COUNT;
            const leg = (N - 1) * COMET_MS_PER_LED;
            const roundTrip = leg * 2;
            const phaseMs = Number.isFinite(ageMs) ? ageMs : nowMs;
            const raw = ((phaseMs % roundTrip) + roundTrip) % roundTrip;
            const forward = raw < leg;
            const dir = forward ? 1 : -1;
            // **单摆式位置曲线**：p = (1 - cos(πu)) / 2，u = raw/leg ∈ [0,2]。
            // 端点（u=0/1/2）速度严格为 0 → 折返是 C1 连续的"停一下再回来"，而不是
            // 旧实现的三角波（端点仍有 0.7 倍速、一帧内反向）。
            //
            // 为什么必须这样修（实测证据）：旧曲线下，端点旁那颗灯（如右端的第 6 颗）
            // 在一帧（4.17ms）内从 "头在 5.9967" 跳到 "头在 5.9879"，高斯强度差 2.5% →
            // 8 位输出 42→41→43，即**单帧 2 LSB 的凹陷**；240Hz 下看起来就是"两头极快微闪"。
            // 单摆曲线在端点附近位移是二次的（每帧 <0.001 颗灯），同样的凹陷被摊到 ~70ms，
            // 变成不可见的缓慢呼吸，且中段速度只比旧曲线快 ~20%（不会显得赶）。
            const u = raw / leg;
            const p = (1 - Math.cos(Math.PI * u)) / 2; // 0..1..0
            const head = p * (N - 1);
            // 不对称性（峰值前移 + 尾巴略长）随 sin(πp) 收敛：**到端点变成对称光斑**。
            // 这是"转向时整条闪一下"的根因 —— dir 翻转会让前后 σ 互换、峰值偏移跳变；
            // 端点对称后，翻转前后的画面完全一致，就不闪了。
            const asym = Math.sin(Math.PI * p);
            const peak = head + dir * 0.3 * asym;
            const SIG_AHEAD = 1.0;
            const SIG_BEHIND = 1.0 + 0.2 * asym;
            const floor = alerting ? 0.18 * alertEnvelope(nowMs) : 0;
            const STAGGER_MS = 55;
            const RISER_MS = 180;
            const reveal = (i) => {
                const local = ageMs - i * STAGGER_MS;
                if (!Number.isFinite(local))
                    return 1;
                if (local <= 0)
                    return 0;
                return Math.min(1, local / RISER_MS);
            };
            for (let i = 0; i < N; i += 1) {
                const d = (i - peak) * dir;
                const sigma = d > 0 ? SIG_AHEAD : SIG_BEHIND;
                const k = Math.max(Math.exp(-((d / sigma) ** 2)), floor);
                writeScaled(pixelAt(out, i), base, k * reveal(i), level);
            }
            break;
        }
        case 'waiting': {
            // 琥珀呼吸：**完整正弦**从 0.12 到 1.0。
            // 之前写成 Math.max(0.35, sin) 会把下半周期截成平底 —— 看起来就是"一顿一顿"。
            const wave = breathe(nowMs, 2400);
            // muted（看过了）只是不再脉动，**不降亮度**（和 done/error 保持同一条规则）
            const k = muted ? 1 : 0.12 + 0.88 * wave;
            const flash = alerting ? alertEnvelope(nowMs) : 0;
            const finalK = Math.max(k, flash);
            for (let i = 0; i < LED_COUNT; i += 1)
                writeScaled(pixelAt(out, i), base, finalK, level);
            break;
        }
        case 'done': {
            // 绿：**常亮**，不做任何呼吸 —— 渐变结束之后亮度就不该再变
            //（之前非 MUTED 时会呼吸，用户看到的是"淡入完成后又变了一下"）。
            // 只有"提醒中"才会周期性双闪，那时是有意为之。
            const flash = alerting ? alertEnvelope(nowMs) : 0;
            // 不做任何"自动变暗"：亮度只由配置决定（muted 仅表示"看过了"，不再降档）
            const k = alerting ? Math.max(0.35, flash) : 1;
            for (let i = 0; i < LED_COUNT; i += 1)
                writeScaled(pixelAt(out, i), base, k, level);
            break;
        }
        case 'warn': {
            // 黄：**常亮**（1 秒瞬态，由控制器计时）。不呼吸、不闪、不看聚焦 —— 用户明确要求
            // "无论是否聚焦都只亮 1s"，它是一次性警告信号，不是持续状态。
            for (let i = 0; i < LED_COUNT; i += 1)
                writeScaled(pixelAt(out, i), base, 1, level);
            break;
        }
        case 'error': {
            // 红：800ms 周期（你的规格）。边缘用 120ms 平滑；**不做时间抖动**（见 link 侧），
            // 抖在低亮度上会变成可见的"沙沙"闪动（慢放看出来的那种抖动）。
            const period = 800;
            const onRatio = 0.55;
            const e = 120 / 800;
            const phase = (nowMs % period) / period;
            const blinkOf = (x) => {
                if (x < e)
                    return x / e; // 升（周期起点）
                if (x < onRatio - e)
                    return 1; // 亮平台
                if (x < onRatio)
                    return 1 - (x - (onRatio - e)) / e; // 降
                return 0; // 其余时间**全灭**（不在末尾再升一次）
            };
            const blink = blinkOf(phase);
            const flash = alerting ? alertEnvelope(nowMs) : 0;
            // **按需闪烁**：只有"提醒闩还挂着"（还没被看到）时才闪；
            // 人回来/确认之后转成**常亮红**，一直亮到保鲜期结束 —— 再闪就是骚扰。
            const k = alerting ? Math.max(blink, flash) : 1;
            for (let i = 0; i < LED_COUNT; i += 1)
                writeScaled(pixelAt(out, i), base, k, level);
            break;
        }
        default: {
            for (let i = 0; i < LED_COUNT; i += 1)
                writeBlack(pixelAt(out, i));
            break;
        }
    }
    return out;
}
/** 纯函数版本（一次性调用/单测用；帧循环请用 renderPixelsInto / createPixelFrame）。 */
export function renderPixels(scene, nowMs, ageMs = Number.POSITIVE_INFINITY) {
    return renderPixelsInto([], scene, nowMs, ageMs);
}
export function createPixelFrame() {
    const pixels = Array.from({ length: LED_COUNT }, () => ({ r: 0, g: 0, b: 0 }));
    return {
        pixels,
        render(scene, nowMs, ageMs = Number.POSITIVE_INFINITY) {
            return renderPixelsInto(pixels, scene, nowMs, ageMs);
        },
        blend(a, b, k) {
            return blendPixelsInto(pixels, a, b, k);
        },
        dither(frame) {
            return ditherPixelsInto(pixels, frame);
        },
        copyFrom(src) {
            for (let i = 0; i < LED_COUNT; i += 1) {
                const px = pixelAt(pixels, i);
                const from = src[i] ?? BLACK;
                px.r = from.r;
                px.g = from.g;
                px.b = from.b;
            }
            return pixels;
        },
    };
}
