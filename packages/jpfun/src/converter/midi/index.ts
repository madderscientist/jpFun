import { ANCHOR_KEY } from "../../functions/temporal.js";
import { DEFAULT_PAGE_CONFIG } from "../../layout/page.js";
import { compileScore } from "../../pipeline.js";
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