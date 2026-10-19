/**
 * 调试日志落文件（小型带轮转的写入器）。
 *
 * 为什么自己写：DSH **没有**给插件"写日志文件"的 API（`ctx.logger` 默认只 console +
 * 内存环形缓冲），官方做法是用 `ctx.logger.exporter()` 自己接管输出。这里就是那个接管端：
 *   目录  $DSH_HOME/logs/dsh-desktop-notify/（DSH 自己的启动诊断日志也在 $DSH_HOME/logs/ 下）
 *   文件  dsh-desktop-notify.log，超过 maxBytes 轮转成 .1/.2…，最多保留 keep 份
 *   （全仓唯一的既有轮转先例是 desktop 崩溃报告：保留最近 10 份）
 *
 * ⚠️ **全程异步 I/O**（原来每条 appendFileSync 都在主线程同步写盘）：debug 打开时，
 * 事件风暴里每来一条日志就卡一下主线程，会拖慢心跳/通知/UI —— 日志是观测手段，
 * 不该成为卡顿来源。现在只往内存队列里 push，后台用 fs.promises 批量落盘；
 * 进程退出时最后几条可能丢（debug 日志，可接受）。
 *
 * 一切失败都吞掉：日志写不出去**绝不能**影响通知本身。
 */
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
/** DSH 的 home：优先 $DSH_HOME，退回 ~/.dsh（与 DSH 自己的 logs 目录同一层）。 */
export function dshHome() {
    const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
    return env || join(homedir(), '.dsh');
}
/** 日志目录（$DSH_HOME/logs/<插件名>）。 */
export function logDirFor(pluginName) {
    return join(dshHome(), 'logs', pluginName);
}
export function createFileSink(options) {
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const keep = Math.max(1, options.keep ?? 5);
    const at = (n) => join(options.dir, n === 0 ? options.name : `${options.name}.${n}`);
    const ensureDir = () => mkdir(options.dir, { recursive: true }).then(() => undefined, () => undefined);
    /** 待写队列（写盘慢时由它吸收；有上限防止内存失控）。 */
    let queue = [];
    /** 队列里待写文本的总字节数（条数上限挡不住"几条 MB 级日志"）。 */
    let queueBytes = 0;
    /** 队列字节上限：约 1 MiB；超了丢最旧的行（调试日志，宁可丢也不能撑爆堆）。 */
    const MAX_QUEUE_BYTES = 1024 * 1024;
    /** 队列条数上限。 */
    const MAX_QUEUE_LINES = 4096;
    /** 是否已有一次落盘在飞（同一时刻只允许一个写者，保证顺序）。 */
    let flushing = false;
    /** 估算的当前文件字节数（-1 = 还没统计过）。 */
    let approxBytes = -1;
    /** 上次 stat 校准时刻。 */
    let lastStatAt = 0;
    const rotate = async () => {
        // 先把最旧的一份删掉：否则 at(keep-1) 会被改名成 at(keep)，磁盘上多留一份
        try {
            await rm(at(keep), { force: true });
        }
        catch (e) { /* ignore */ }
        for (let i = keep - 1; i >= 1; i -= 1) {
            try {
                await rename(at(i), at(i + 1));
            }
            catch (e) { /* 不存在就跳过 */ }
        }
        try {
            await rename(at(0), at(1));
        }
        catch (e) { /* ignore */ }
    };
    const flush = async () => {
        if (flushing)
            return;
        flushing = true;
        try {
            await ensureDir();
            while (queue.length > 0) {
                const text = queue.join('');
                queue = [];
                queueBytes = 0;
                const now = Date.now();
                if (approxBytes < 0 || now - lastStatAt > 2000) {
                    lastStatAt = now;
                    try {
                        approxBytes = (await stat(at(0))).size;
                    }
                    catch (e) {
                        approxBytes = 0;
                    }
                }
                if (approxBytes > maxBytes) {
                    await rotate();
                    approxBytes = 0;
                }
                try {
                    await appendFile(at(0), text);
                }
                catch (e) {
                    return;
                }
                approxBytes += Buffer.byteLength(text, 'utf8');
            }
        }
        finally {
            flushing = false;
            // 落盘期间又来了新行：继续排（不递归调用自己，避免深栈）
            if (queue.length > 0)
                void flush();
        }
    };
    return (line) => {
        const text = line + '\n';
        const bytes = Buffer.byteLength(text, 'utf8');
        // 单行本身就超上限：直接丢弃（保留它的前缀没有价值），也别为它清掉整个队列。
        if (bytes > MAX_QUEUE_BYTES)
            return;
        // 上限：写盘彻底卡死 / 单行巨大时也不能让日志把内存撑爆
        // （条数上限挡不住 MB 级单行，所以同时按字节数丢最旧）。
        while (queue.length >= MAX_QUEUE_LINES || queueBytes + bytes > MAX_QUEUE_BYTES) {
            const dropped = queue.shift();
            if (dropped === undefined)
                break;
            queueBytes -= Buffer.byteLength(dropped, 'utf8');
        }
        queue.push(text);
        queueBytes += bytes;
        void flush();
    };
}
