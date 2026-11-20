import type { Track } from "./track.js";

/**
 * 一个音在记忆中的位置：key 为「级数:八度」；bar 只作小节的身份；seq 是读谱顺序；
 * prior 是读到的半音偏移。升降半音补记时按 (bar, key) 分组，按 seq 找第一个
 */
export interface AccidentalReading { key: string; bar: object; seq: number; prior: number }

/**
 * 小节内变音记忆，作用按时间先后：后发生的音读得到先发生的写入，同一时刻的音互不影响。
 * 处理顺序不等于时间顺序（如 ^ 从后往前处理），所以一列里的读写和清空先登记，列末按时刻结算
 */
export class AccidentalMemory {
    private readonly memory = new Map<Track, Map<string, number>>();    // 每个声部本小节的变音：声部轨道 → (键 → 半音偏移，# 为 +1、n 为 0)
    private readonly events: { time: number[]; run: () => void }[] = [];    // 本列登记的读写与清空
    private readonly staged: [Track, string, number][] = [];    // 当前时刻的写入，时刻推进时才提交
    private readonly now: number[] = [];
    private reads = 0;

    /** 在列内时刻 time 处理 run。一列默认都在时刻 0，倚音成员在宿主之前或之后；嵌套时逐级细分，缺省的级为 0 */
    at<T>(time: number, run: () => T): T {
        this.now.push(time);
        try { return run(); } finally { this.now.pop(); }
    }

    /** 登记一个音：结算时读到前文，resolve 返回要写入的半音偏移，不写返回 undefined */
    read(track: Track, key: string, resolve: (reading: AccidentalReading) => number | undefined) {
        const owner = voiceOf(track);
        this.events.push({ time: [...this.now], run: () => {
            const bar = this.scope(owner);
            const offset = resolve({ key, bar, seq: this.reads++, prior: bar.get(key) ?? 0 });
            if (offset !== undefined) this.staged.push([owner, key, offset]);
        } });
    }

    /** 小节线清本轨及其子孙轨道（stack 的分支轨道跨小节复用）；转调不传 track，全部清空 */
    clear(track?: Track) {
        this.events.push({ time: [...this.now], run: () => {
            if (!track) return this.memory.clear();
            for (const owner of this.memory.keys()) if (within(owner, track)) this.memory.delete(owner);
        } });
    }

    /** 列末按时刻结算；同一时刻按处理顺序执行 */
    commit() {
        const events = this.events.splice(0).sort((a, b) => compareTime(a.time, b.time));
        events.forEach(({ time, run }, i) => {
            if (i > 0 && compareTime(events[i - 1].time, time)) this.flush();
            run();
        });
        this.flush();
    }

    private flush() {
        for (const [owner, key, offset] of this.staged.splice(0)) this.scope(owner).set(key, offset);
    }

    /** 当前小节的记忆；清空后会换成新的 Map，因此也作为小节的身份 */
    private scope(owner: Track) {
        let map = this.memory.get(owner);
        if (!map) this.memory.set(owner, map = new Map());
        return map;
    }
}

/** 列内时刻逐级比较，缺省的级视为 0 */
function compareTime(a: readonly number[], b: readonly number[]) {
    for (let i = 0; i < a.length || i < b.length; i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff) return diff;
    }
    return 0;
}

/** 记忆按声部归属：分组里的分支各成声部；不在父轨分组里的子轨（如倚音的私有根轨）只是排版子域，延续父轨的声部 */
function voiceOf(track: Track) {
    while (track.parent && !track.parent.groups.some(group => group.members.includes(track))) track = track.parent;
    return track;
}

function within(track: Track, root: Track) {
    for (let current: Track | null = track; current; current = current.parent) {
        if (current === root) return true;
    } return false;
}
