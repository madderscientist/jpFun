/** midi.js JSON() 返回值的输入契约，转换器只依赖这些字段 */
export interface MidiJsonNote {
    ticks: number;
    durationTicks: number;
    midi: number;
    intensity: number;
}

export interface MidiJsonControlChange {
    ticks: number;
    controller: number;
    value: number;
}

export interface MidiJsonInstrument {
    ticks: number;
    number: number;
}

export interface MidiJsonTrack {
    channel: number;
    name: string;
    controlChanges: readonly MidiJsonControlChange[];
    instruments: readonly MidiJsonInstrument[];
    notes: readonly MidiJsonNote[];
}

export interface MidiJson {
    header: {
        name: string;
        tick: number;
        tempos: readonly { ticks: number; bpm: number }[];
        timeSignatures: readonly { ticks: number; timeSignature: readonly [number, number] }[];
    };
    tracks: readonly MidiJsonTrack[];
}