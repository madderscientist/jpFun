import { ANCHOR_KEY, DEFAULT_PAGE_CONFIG, compileScore } from "jpfun";
import {
    convertMidiJsonToJpFun,
    type MidiToJpFunOptions,
} from "./convert.js";
import type { MidiJson } from "./json.js";

export type * from "./json.js";
export type { MidiToJpFunOptions } from "./convert.js";

export function midiJsonToJpFun(input: MidiJson, options: MidiToJpFunOptions = {}) {
    return convertMidiJsonToJpFun(input, options, {
        compileScore,
        anchorKey: ANCHOR_KEY,
        page: DEFAULT_PAGE_CONFIG,
    });
}