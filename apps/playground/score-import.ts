import { loadMidiApi } from "./midi-api.js";

function scoreTitle(fileName: string) {
    return fileName.replace(/\.[^.]*$/, "") || "score";
}

function jpFunName(fileName: string) {
    return `${scoreTitle(fileName)}.jpfun`;
}

function parseMusicXml(source: string) {
    const document = new DOMParser().parseFromString(source, "application/xml");
    const error = document.querySelector("parsererror");
    if (error) throw new SyntaxError(`Invalid MusicXML: ${error.textContent?.trim() || "parse error"}`);
    return document.documentElement;
}

export function isSupportedScoreFile(file: { readonly name: string }) {
    return /\.(?:jpfun|mid|midi|musicxml)$/i.test(file.name);
}

export async function importScoreFile(file: File) {
    const extension = file.name.match(/\.([^.]+)$/)?.[1].toLowerCase();
    if (extension === "jpfun") {
        return { source: await file.text(), fileName: file.name, linked: true };
    }
    if (extension === "musicxml") {
        const { musicXmlToJpFun } = await import("jpfun/converter/musicxml");
        return {
            source: musicXmlToJpFun(parseMusicXml(await file.text())),
            fileName: jpFunName(file.name),
            linked: false,
        };
    }
    if (extension === "mid" || extension === "midi") {
        const { midiJsonToJpFun } = await import("jpfun/converter/midi");
        const { midi } = await loadMidiApi();
        const parsed = midi.import(new Uint8Array(await file.arrayBuffer()));
        if (!parsed) throw new TypeError("无法识别 MIDI 文件");
        return {
            source: midiJsonToJpFun(parsed.JSON(), { title: scoreTitle(file.name) }),
            fileName: jpFunName(file.name),
            linked: false,
        };
    }
    throw new TypeError(`不支持的文件类型：${file.name}`);
}