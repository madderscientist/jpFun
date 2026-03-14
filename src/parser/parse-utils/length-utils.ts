import { Diagnostic } from "../diagnostic";
import { LengthValue } from "../types";

const LENGTH_RE = /^([\d.]+)([a-z%]+)?$/i;
const availableUnits = ["em", "px"];

export function parseLength(value: string): LengthValue | Diagnostic {
    const match = value.match(LENGTH_RE);
    if (!match) return Diagnostic.warning.InvalidLength(value, { start: 0, end: value.length });
    const num = parseFloat(match[1]);
    if (match[2]) {
        const unit = match[2].toLowerCase();
        if (availableUnits.includes(unit))
            return { value: num, unit: unit as LengthValue["unit"] };
        else return Diagnostic.warning.InvalidLengthUnit(unit, { start: match[1].length, end: value.length });
    } else {
        // 没有单位，默认为 px
        return { value: num, unit: "px" };
    }
}