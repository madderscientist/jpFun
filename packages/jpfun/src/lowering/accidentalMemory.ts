import type { Track } from "./track.js";

/**
 * 一个音在记忆中的位置：key 为「级数:八度」；bar 是所在小节的记忆，也作为小节的身份；
 * seq 是读谱顺序。升降半音补记时按 (bar, key) 分组，按 seq 找第一个
 */
export interface AccidentalReading { key: string; bar: ReadonlyMap<string, number>; seq: number }

/**
 * 小节内变音记忆：写入只看显示出来的记号，读取只看已提交的记忆。
 * 同一列的写入先暂存、列末统一提交，因此同时音互不影响。
 */
export class AccidentalMemory {
    private readonly memory = new Map<Track, Map<string, number>>();    // 每个声部本小节已提交的变音：所有者轨道 → (键 → 半音偏移，# 为 +1、n 为 0)
    private readonly staged: [Track, string, number][] = [];    // 本列尚未提交的写入：[所有者轨道, 键, 半音偏移]，按处理顺序排列
    private readonly aliases = new Map<Track, Track>(); // 共用记忆的轨道 → 宿主轨道；owner() 沿此链解析到真正的所有者
    private reads = 0;

    /** 倚音主线的排版轨道与宿主共用记忆；嵌套倚音会形成别名链 */
    share(track: Track, owner: Track) {
        this.aliases.set(track, owner);
    }

    /** 读取一个音的位置，并记下读谱顺序 */
    read(track: Track, key: string): AccidentalReading {
        return { key, bar: this.scope(track), seq: this.reads++ };
    }

    /** 当前小节的记忆；小节线清空后会换成新的 Map，因此也作为小节的身份 */
    private scope(track: Track) {
        const owner = this.owner(track);
        let map = this.memory.get(owner);
        if (!map) this.memory.set(owner, map = new Map());
        return map;
    }

    /** 同一列对同一键多次写入时，最后处理的为准 */
    stage(track: Track, key: string, offset: number) {
        this.staged.push([this.owner(track), key, offset]);
    }

    /** 当前暂存条数；倚音记下它，之后只提交自己的写入 */
    get pending() {
        return this.staged.length;
    }

    /** 提交第 from 条之后的暂存；列末不传参数，全部提交 */
    commit(from = 0) {
        for (const [owner, key, offset] of this.staged.splice(from)) this.scope(owner).set(key, offset);
    }

    /** 小节线清本轨及其子孙轨道（stack 的分支轨道跨小节复用）；转调不传 track，全部清空 */
    clear(track?: Track) {
        if (!track) return this.memory.clear();
        for (const owner of this.memory.keys()) if (within(owner, track)) this.memory.delete(owner);
    }

    private owner(track: Track) {
        while (this.aliases.has(track)) track = this.aliases.get(track)!;
        return track;
    }
}

function within(track: Track, root: Track) {
    for (let current: Track | null = track; current; current = current.parent) {
        if (current === root) return true;
    } return false;
}
