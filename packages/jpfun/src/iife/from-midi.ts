import {
    convertMidiJsonToJpFun,
    type MidiLayoutCapability,
    type MidiToJpFunOptions,
} from "../converter/midi/convert.js";
import type { MidiJson } from "../converter/midi/json.js";

type CoreGlobal = Record<string, unknown> & {
    compileScore?: MidiLayoutCapability["compileScore"];
    ANCHOR_KEY?: number;
    DEFAULT_PAGE_CONFIG?: MidiLayoutCapability["page"];
};

const target = globalThis as typeof globalThis & { jpfun?: CoreGlobal };
const api = target.jpfun ??= {};

Object.assign(api, {
    midiJsonToJpFun(input: MidiJson, options: MidiToJpFunOptions = {}) {
        const layoutCapability = (options.barsPerLine ?? 0) <= 0
            ? {
                compileScore: api.compileScore!,
                anchorKey: api.ANCHOR_KEY!,
                page: api.DEFAULT_PAGE_CONFIG!,
            }
            : undefined;
        return convertMidiJsonToJpFun(input, options, layoutCapability);
    },
});