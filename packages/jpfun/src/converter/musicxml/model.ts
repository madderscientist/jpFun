import type { Fraction } from "../../fraction.js";

export interface MusicXmlDiagnostic {
    code: "W_MUSICXML_PERCUSSION_SKIPPED" | "W_MUSICXML_APPROXIMATED"
        | "W_MUSICXML_UNSUPPORTED_ELEMENT" | "W_MUSICXML_UNATTACHED_CONTENT"
        | "W_MUSICXML_UNRESOLVED_RELATION";
    severity: "warning";
    message: string;
    location: {
        element: string;
        partId?: string;
        measureIndex?: number;
        measureNumber?: string;
        staff?: string;
        voice?: string;
    };
}

type MusicXmlPartLocation = MusicXmlDiagnostic["location"] & {
    partId: string;
    measureIndex: number;
};

export interface MusicXmlArpeggio {
    direction: "none" | "up" | "down";
    location: MusicXmlPitch["location"];
}

/** 单个书面音高，tie 标记保留在音高上以支持和弦成员独立连音 */
export interface MusicXmlPitch {
    location: MusicXmlPartLocation & { staff: string; voice: string };
    step: string;
    alter: number;
    octave: number;
    tieStart: boolean;
    tieStop: boolean;
}

/** 一个 lane 上的原子事件，同起止音高已合并为一个和弦事件 */
export interface MusicXmlEvent {
    start: Fraction;
    duration: Fraction;
    pitches: MusicXmlPitch[];
    rest: boolean;
    order: number;
    modifiers: { name: string; placement: "above" | "below" }[];
    annotations: { text: string; placement: "above" | "below"; boxed?: boolean }[];
    preGraces: MusicXmlPitch[][];
    postGraces: MusicXmlPitch[][];
    lyrics: Map<string, string>;
    arpeggio?: MusicXmlArpeggio;
    program?: number;
    timeModification?: {
        actual: number;
        normal: number;
        start: boolean;
        stop: boolean;
    };
}

/** MusicXML 的 part + staff + voice 对应一条 jpFun lane */
export interface MusicXmlLane {
    partId: string;
    partName: string;
    staff: string;
    voice: string;
    events: MusicXmlEvent[];
    dynamics?: ({ at: Fraction; location: MusicXmlDiagnostic["location"] } & MusicXmlEvent["modifiers"][number])[];
}

/** 全谱时间流上的拍号状态点 */
export interface MusicXmlMeterPoint {
    at: Fraction;
    numerator: number;
    denominator: number;
}

/** 全谱时间流上的调号状态点 */
export interface MusicXmlKeyPoint {
    at: Fraction;
    fifths: number;
    mode: string;
}

/** 尚未附着到事件的力度或文字方向 */
export interface MusicXmlDirectionPoint {
    location: MusicXmlPartLocation & { staff: string };
    at: Fraction;
    placement: "above" | "below";
    dynamic?: string;
    texts: { text: string; boxed: boolean }[];
}

/** 参与楔形线配对的原始起止点 */
export interface MusicXmlWedgePoint {
    location: MusicXmlDirectionPoint["location"];
    at: Fraction;
    number: string;
    type: "crescendo" | "diminuendo" | "stop";
}

/** 已配对的渐强或渐弱区间 */
export interface MusicXmlWedgeSpan {
    from: MusicXmlWedgePoint;
    end: Fraction;
}

/** 参与房子配对的原始起止点 */
export interface MusicXmlEndingPoint {
    location: MusicXmlPartLocation;
    at: Fraction;
    type: "start" | "stop" | "discontinue";
    passes: number[];
}

/** 已配对的房子区间，遍数语义由起点持有 */
export interface MusicXmlEndingSpan {
    from: MusicXmlEndingPoint;
    end: Fraction;
}

/** XML 解析完成后的格式无关乐谱模型，渲染阶段不再读取 DOM */
export interface ParsedMusicXmlScore {
    title: string;
    subtitle: string;
    creator: string;
    page?: {
        width: number;
        height: number;
        top: number;
        bottom: number;
        left: number;
        right: number;
    };
    lanes: MusicXmlLane[];
    meters: MusicXmlMeterPoint[];
    keys: MusicXmlKeyPoint[];
    tempos: { at: Fraction; bpm: number; location?: MusicXmlDiagnostic["location"] }[];
    wedges: MusicXmlWedgeSpan[];
    endings: MusicXmlEndingSpan[];
    bars: Map<string, string>;
    measureBoundaries: Set<string>;
    lineBreaks: Set<string>;
    end: Fraction;
}