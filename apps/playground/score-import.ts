import { loadMidiApi } from "./midi-api.js";
import { fileBaseName } from "./platform.js";

const MAX_MXL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8");

interface ZipEntry {
    readonly name: string;
    readonly flags: number;
    readonly method: number;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    readonly offset: number;
}

function jpFunName(fileName: string) {
    return `${fileBaseName(fileName)}.jpfun`;
}

/** 按 BOM 或前导 `<` 的零字节识别 UTF-16，其余优先尊重 XML 声明中的 encoding */
function decodeXmlBytes(bytes: Uint8Array): string {
    if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0x00)) {
        return new TextDecoder("utf-16le").decode(bytes);
    }
    if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0x00 && bytes[1] === 0x3c)) {
        return new TextDecoder("utf-16be").decode(bytes);
    }
    const header = new TextDecoder("latin1").decode(bytes.subarray(0, 256));
    const declared = header.match(/^\s*<\?xml\b[^?]*?\bencoding\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    if (declared && !/^utf-?8$/i.test(declared)) {
        try { return new TextDecoder(declared).decode(bytes); } catch { /* 未知编码标签回退 UTF-8 */ }
    }
    return utf8Decoder.decode(bytes);
}

function parseXml(source: string) {
    const doc = new DOMParser().parseFromString(source, "application/xml");
    const error = doc.querySelector?.("parsererror") ?? doc.getElementsByTagName("parsererror")[0];
    if (error || !doc.documentElement) {
        throw new SyntaxError(`Invalid MusicXML: ${error?.textContent?.trim() || "parse error"}`);
    }
    return doc.documentElement;
}

function normalizePath(path: string) {
    return path.replaceAll("\\", "/").replace(/^(?:\.\/|\/)+/, "");
}

/** 流式生成的 ZIP 本地头可能不含压缩尺寸，统一从末尾中央目录读取条目元数据 */
function readZipEntries(archive: Uint8Array, view: DataView): ZipEntry[] {
    let eocd = -1;
    for (let i = archive.byteLength - 22, min = Math.max(0, i - 0xffff); i >= min; i--) {
        if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === archive.byteLength) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new SyntaxError("无效的 .mxl 压缩文件");

    const count = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    const cdEnd = cdOffset + cdSize;
    if (view.getUint16(eocd + 4, true) !== 0 || count === 0xffff || cdEnd > eocd) {
        throw new SyntaxError("无效或不受支持的 .mxl 压缩目录");
    }

    const entries: ZipEntry[] = [];
    for (let index = 0, cursor = cdOffset; index < count; index++) {
        if (cursor + 46 > cdEnd || view.getUint32(cursor, true) !== 0x02014b50) {
            throw new SyntaxError("损坏的 .mxl 压缩目录条目");
        }
        const nameLen = view.getUint16(cursor + 28, true);
        const next = cursor + 46 + nameLen + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
        if (next > cdEnd) throw new SyntaxError("损坏的 .mxl 压缩目录条目");

        const rawName = utf8Decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLen));
        if (!/[\\/]$/.test(rawName)) {
            const name = normalizePath(rawName);
            if (name) entries.push({
                name,
                flags: view.getUint16(cursor + 8, true),
                method: view.getUint16(cursor + 10, true),
                compressedSize: view.getUint32(cursor + 20, true),
                uncompressedSize: view.getUint32(cursor + 24, true),
                offset: view.getUint32(cursor + 42, true),
            });
        }
        cursor = next;
    }
    return entries;
}

/** 按块流式解压原始 deflate 数据，并在解压途中拦截超限膨胀数据 */
async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
    const copy = new Uint8Array(compressed.byteLength);
    copy.set(compressed);
    const reader = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if ((total += value.byteLength) > MAX_MXL_UNCOMPRESSED_BYTES) {
                await reader.cancel();
                throw new RangeError(".mxl 解压内容超出大小限制");
            }
            chunks.push(value);
        }
    } catch (error) {
        if (error instanceof RangeError) throw error;
        throw new SyntaxError("无法解压 .mxl 条目", { cause: error });
    }
    const output = new Uint8Array(total);
    for (let i = 0, offset = 0; i < chunks.length; offset += chunks[i++].byteLength) {
        output.set(chunks[i], offset);
    }
    return output;
}

async function readZipEntry(archive: Uint8Array, view: DataView, entry: ZipEntry): Promise<Uint8Array> {
    if (entry.flags & 0x0001) throw new SyntaxError("不支持加密的 .mxl 文件");
    if (entry.uncompressedSize > MAX_MXL_UNCOMPRESSED_BYTES
        || (entry.method === 0 && entry.compressedSize > MAX_MXL_UNCOMPRESSED_BYTES)) {
        throw new RangeError(".mxl 解压内容超出大小限制");
    }
    const lh = entry.offset;
    if (lh + 30 > archive.byteLength || view.getUint32(lh, true) !== 0x04034b50) {
        throw new SyntaxError("损坏的 .mxl 本地文件头");
    }
    // 本地头的 extra 长度可能与中央目录不同，须以本地头自身偏移定位载荷起点
    const start = lh + 30 + view.getUint16(lh + 26, true) + view.getUint16(lh + 28, true);
    const end = start + entry.compressedSize;
    if (end > archive.byteLength) throw new SyntaxError("损坏的 .mxl 条目数据");

    const payload = archive.subarray(start, end);
    if (entry.method === 0) return payload;
    if (entry.method === 8) return inflateRaw(payload);
    throw new SyntaxError(`不支持的 .mxl 压缩方式：${entry.method}`);
}

function findEntry(entries: readonly ZipEntry[], rawPath: string) {
    const plain = normalizePath(rawPath);
    let decoded = plain;
    try { decoded = normalizePath(decodeURIComponent(plain)); } catch { /* 非法转义保留原路径 */ }
    const lower = decoded.toLowerCase();
    return entries.find(e => e.name === plain || e.name === decoded)
        ?? entries.find(e => e.name.toLowerCase() === lower);
}

/** 按 MusicXML 容器规范读取 META-INF/container.xml 中的主谱路径，跳过 PDF 等附带条目 */
function resolveContainerRoot(containerXml: string): string {
    const root = parseXml(containerXml);
    const files = [...root.getElementsByTagName("*")]
        .filter(el => (el.localName || el.tagName.split(":").at(-1)) === "rootfile")
        .map(el => ({
            path: el.getAttribute("full-path")?.trim() ?? "",
            type: el.getAttribute("media-type")?.trim().toLowerCase() ?? "",
        }))
        .filter(item => item.path.length > 0);
    const picked = files.find(f => !f.type || f.type.includes("xml")) ?? files[0];
    if (!picked) throw new SyntaxError("Invalid MXL container.xml: missing <rootfile>");
    return picked.path;
}

/** 解压 .mxl（ZIP 容器）并提取主 MusicXML 文本；缺失 container.xml 时回退查找顶层谱面文件 */
async function extractMxlXml(archive: Uint8Array): Promise<string> {
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const entries = readZipEntries(archive, view);
    const container = findEntry(entries, "META-INF/container.xml");

    let scoreEntry: ZipEntry | undefined;
    if (container) {
        const rootPath = resolveContainerRoot(decodeXmlBytes(await readZipEntry(archive, view, container)));
        scoreEntry = findEntry(entries, rootPath);
        if (!scoreEntry) throw new SyntaxError(`.mxl 中未找到曲谱条目：${rootPath}`);
    } else {
        const candidates = entries.filter(e => {
            const lower = e.name.toLowerCase();
            return !lower.startsWith("meta-inf/") && !lower.startsWith("__macosx/")
                && !lower.split("/").some(seg => seg.startsWith("."));
        });
        scoreEntry = candidates.find(e => /\.musicxml$/i.test(e.name))
            ?? candidates.find(e => /\.xml$/i.test(e.name));
        if (!scoreEntry) throw new SyntaxError("无效的 .mxl 文件：缺少 META-INF/container.xml");
    }
    return decodeXmlBytes(await readZipEntry(archive, view, scoreEntry));
}

export function isSupportedScoreFile(file: { readonly name: string }) {
    return /\.(?:jpfun|mid|midi|musicxml|mxl|xml)$/i.test(file.name);
}

export async function importScoreFile(file: File) {
    const extension = file.name.match(/\.([^.]+)$/)?.[1].toLowerCase();
    if (extension === "jpfun") {
        return { source: await file.text(), fileName: file.name, linked: true };
    }
    if (extension === "musicxml" || extension === "xml" || extension === "mxl") {
        const [{ musicXmlToJpFun }, buffer] = await Promise.all([
            import("@jpfun/convert/musicxml"),
            file.arrayBuffer(),
        ]);
        const bytes = new Uint8Array(buffer);
        const xml = extension === "mxl" ? await extractMxlXml(bytes) : decodeXmlBytes(bytes);
        return {
            source: musicXmlToJpFun(parseXml(xml)).script,
            fileName: jpFunName(file.name),
            linked: false,
        };
    }
    if (extension === "mid" || extension === "midi") {
        const { midiJsonToJpFun } = await import("@jpfun/convert/midi");
        const { midi } = await loadMidiApi();
        const parsed = midi.import(new Uint8Array(await file.arrayBuffer()));
        if (!parsed) throw new TypeError("无法识别 MIDI 文件");
        return {
            source: midiJsonToJpFun(parsed.JSON(), { title: fileBaseName(file.name) }),
            fileName: jpFunName(file.name),
            linked: false,
        };
    }
    throw new TypeError(`不支持的文件类型：${file.name}`);
}