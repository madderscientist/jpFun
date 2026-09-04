export interface MusicXmlNode {
    readonly nodeType: number;
}

/** 浏览器 Element 与第三方 XML DOM 都能满足的最小读取接口 */
export interface MusicXmlElement extends MusicXmlNode {
    readonly localName: string | null;
    readonly tagName: string;
    readonly childNodes: ArrayLike<MusicXmlNode>;
    readonly textContent: string | null;
    getAttribute(name: string): string | null;
}

/** 读取忽略命名空间前缀的元素名 */
export function nameOf(element: MusicXmlElement) {
    return element.localName || element.tagName.split(":").at(-1)!;
}

/** 返回全部直接子元素，可按元素名筛选 */
export function children(parent: MusicXmlElement, name?: string) {
    const result: MusicXmlElement[] = [];
    for (let index = 0; index < parent.childNodes.length; index++) {
        const node = parent.childNodes[index];
        if (node.nodeType !== 1) continue;
        const element = node as MusicXmlElement;
        if (name === undefined || nameOf(element) === name) result.push(element);
    } return result;
}

/** 返回第一个同名直接子元素 */
export function child(parent: MusicXmlElement, name: string) {
    for (let index = 0; index < parent.childNodes.length; index++) {
        const node = parent.childNodes[index];
        if (node.nodeType === 1 && nameOf(node as MusicXmlElement) === name) return node as MusicXmlElement;
    } return void 0;
}

/** 按文档顺序深度优先查找第一个同名后代元素 */
export function descendant(parent: MusicXmlElement, name: string): MusicXmlElement | undefined {
    for (const item of children(parent)) {
        if (nameOf(item) === name) return item;
        const nested = descendant(item, name);
        if (nested) return nested;
    } return void 0;
}

/** 按文档顺序收集全部同名后代元素 */
export function descendants(parent: MusicXmlElement, name: string): MusicXmlElement[] {
    const result: MusicXmlElement[] = [];
    for (const item of children(parent)) {
        if (nameOf(item) === name) result.push(item);
        result.push(...descendants(item, name));
    } return result;
}

/** 读取自身或同名直接子元素的去空白文本 */
export function text(parent: MusicXmlElement | undefined, name?: string) {
    const element = name === undefined ? parent : parent && child(parent, name);
    return element?.textContent?.trim() ?? "";
}

/** 读取有限数值，缺失时使用显式 fallback 或抛错 */
export function number(parent: MusicXmlElement | undefined, name: string, fallback?: number) {
    const source = text(parent, name);
    if (source === "") {
        if (fallback !== undefined) return fallback;
        throw new RangeError(`MusicXML <${name}> must contain a finite number`);
    }
    const value = Number(source);
    if (Number.isFinite(value)) return value;
    throw new RangeError(`MusicXML <${name}> must contain a finite number`);
}