/**
 * 基于弹簧的有时长物体排版模型 原理参考 docs/layout.md
 * 基本使用: 借助 layoutElement() 构建 LayoutElement[][]，调用 layout() 函数进行排版
 */
import type { HorizontalSpringConfig, LayoutBox, TimeLineEvent } from "./types.js";

const DEFAULT_F = 1.0;  // 多大力让一行的 margin 全变为 0
const DEFAULT_ALPHA = 6;    // 控制无约束时元素的margin
const DEFAULT_MU = 16;
const DEFAULT_CROSS_PUNISH = 32;

type _LayoutBox = Pick<LayoutBox, 'w' | 'x' | 'anchor'>;
export interface LayoutElement {
    config: Required<HorizontalSpringConfig>;
    box: _LayoutBox;
    time: TimeLineEvent;
    duration_L: number; // 左右边界分别保留时长，刚性合并时可继承首尾元素
    duration_R: number; // 之所以有左右是因为合并列的时候最左边和最右边来自不同的元素
    // 求解器内部使用的状态属性
    WL: number;     // 左物理宽度
    WR: number;     // 右物理宽度
    margin_L: number;   // 无约束弹簧长度
    margin_R: number;
    fake?: boolean; // 占位符标记
}

const MIN_DURATION = 0.01;

/**
 * 原地补齐全部弹簧属性
 *
 * 关系修饰在完整配置上只修改自己声明的属性：
 * beam 缩短 alpha 时不会隐式重算 beta，anchor 增大 mu 时也不会影响其他参数。
 */
export function completeSpringConfig(
    config: HorizontalSpringConfig,
    F: number = DEFAULT_F,
): asserts config is Required<HorizontalSpringConfig> {
    const defaultAlpha = config.alpha_L ?? config.alpha_R ?? DEFAULT_ALPHA;
    config.alpha_L ??= defaultAlpha;
    config.alpha_R ??= defaultAlpha;

    const defaultMu = config.mu_L ?? config.mu_R ?? DEFAULT_MU;
    config.mu_L ??= defaultMu;
    config.mu_R ??= defaultMu;

    config.beta_L ??= F / config.alpha_L;
    config.beta_R ??= F / config.alpha_R;
}

// 有副作用：确保直接调用时也能消费尚未补齐的配置
export function layoutElement(
    config: HorizontalSpringConfig,
    box: _LayoutBox,
    time: TimeLineEvent,
    F: number = DEFAULT_F,
): LayoutElement {
    completeSpringConfig(config, F);

    // 最小时长限制，与非线性变换（美观）
    const duration = Math.pow(Math.max(time.T, MIN_DURATION), 0.5);

    return {
        config, box, time,
        duration_L: duration,
        duration_R: duration,
        WL: box.anchor,
        WR: box.w - box.anchor,
        margin_L: duration * config.alpha_L,
        margin_R: duration * config.alpha_R,
    };
}

/**
 * 补齐列中缺损声部元素的占位工具函数
 * @param columns: 第一维度为列
 */
function fillPlaceholders(columns: LayoutElement[][], F: number = DEFAULT_F): {
    mat: LayoutElement[][]; // 二维矩阵，第一维为列，第二维为行，包含占位元素
    rows: number;           // 行数 不一定等于 colums[0].length，因为可能一个声部有多个
} {
    const idOrderMap = new Map<any, number>();
    let rows = 0;
    for (const col of columns) {
        for (const el of col) {
            // undefined 和 null 都算有效的 id
            if (idOrderMap.has(el.time.track)) continue;
            idOrderMap.set(el.time.track, rows++);
        }
    }

    const mat: LayoutElement[][] = [];

    for (const col of columns) {
        if (col.length === 0) continue;

        const sortedCol = Array(col.length);
        mat.push(sortedCol);

        let maxLeft = 0;
        let maxRight = 0;
        let same = rows;
        for (const el of col) {
            if (el.WL > maxLeft) maxLeft = el.WL;
            if (el.WR > maxRight) maxRight = el.WR;
            const rIdx = idOrderMap.get(el.time.track) as number;
            if (sortedCol[rIdx]) {
                // 出现了同一行同一时刻的多个元素，则优先时长更大的
                // 重复的元素放到最后，不参与后续的元素比较
                const elExist = sortedCol[rIdx];
                if (el.time.T > elExist.time.T) {
                    sortedCol[rIdx] = el;
                    sortedCol[same++] = elExist;
                } else {
                    sortedCol[same++] = el;
                }
            } else sortedCol[rIdx] = el;
        }

        // 填充不足的部分
        const colTime = col[0].time.t;
        for (const rowId of idOrderMap) {
            const rIdx = rowId[1];
            if (!sortedCol[rIdx]) {
                // 保证 margin_L = mexLeft, margin_R = maxRight, 实际宽度为0
                const elPlaceholder = layoutElement({
                    anchor: 0,
                    alpha_L: maxLeft,
                    alpha_R: maxRight,
                } as HorizontalSpringConfig, {
                    x: 0, w: 0, anchor: 0
                } as _LayoutBox, {
                    t: colTime, T: 1, track: rowId[0]
                } as TimeLineEvent, F);
                elPlaceholder.fake = true;
                sortedCol[rIdx] = elPlaceholder;
            }
        }
    } return { mat, rows };
}

//==== 物理模拟 ====
interface ForceStiffnessResult {
    force: number;
    stiffness: number;  // 等效弹簧的刚度，用于 CG 内部计算 是力的梯度
}

// 串联弹簧力学解析
function calcPairForceAndStiffness(el: LayoutElement, er: LayoutElement, xl: number, xr: number): ForceStiffnessResult {
    const dis_eff = (xr - xl) - el.WR - er.WL;
    const m0_total = el.margin_R + er.margin_L;
    if (dis_eff >= m0_total) return { force: 0, stiffness: 0 };

    // 计算等效弹簧参数
    const k_R1 = el.config.beta_R / el.duration_R;
    const k_L2 = er.config.beta_L / er.duration_L;
    const K_normal = (k_R1 * k_L2) / (k_R1 + k_L2);

    let force, stiffness;
    if (dis_eff < 0) {
        const K_overlap = (el.config.mu_R * er.config.mu_L) / (el.config.mu_R + er.config.mu_L);
        force = K_normal * m0_total - K_overlap * dis_eff;  // 重合前的最大力+重合后的线性增长力
        stiffness = K_overlap;
    } else {
        const dl = m0_total - dis_eff;
        force = K_normal * dl;
        stiffness = K_normal;
    } return { force, stiffness };
}

function calcLeftWall(e: LayoutElement, x: number, crossPunish: number = DEFAULT_CROSS_PUNISH): ForceStiffnessResult {
    const dis = x - e.WL;
    const m0 = e.margin_L;
    if (dis >= m0) return { force: 0, stiffness: 0 };

    const k = e.config.beta_L / e.duration_L;
    if (dis >= 0) return { force: k * (m0 - dis), stiffness: k };

    const stiffness = e.config.mu_L * crossPunish;
    const force = e.config.alpha_L * e.config.beta_L - stiffness * dis;
    return { force, stiffness };
}

function calcRightWall(e: LayoutElement, x: number, limit: number, crossPunish: number = DEFAULT_CROSS_PUNISH): ForceStiffnessResult {
    const dis = limit - (x + e.WR);
    const m0 = e.margin_R;
    if (dis >= m0) return { force: 0, stiffness: 0 };

    const k = e.config.beta_R / e.duration_R;
    if (dis >= 0) return { force: k * (m0 - dis), stiffness: k };

    const stiffness = e.config.mu_R * crossPunish;
    const force = e.config.alpha_R * e.config.beta_R - stiffness * dis;
    return { force, stiffness };
}

/**
 * 求解器运行参数
 */
export interface SolverOptions {
    damping?: number;      // 阻尼系数（默认 0.6）
    maxIter?: number;      // 最大迭代步数（默认 100）
    eps?: number;          // 收敛阈值（默认 1e-2）
    crossPunish?: number;  // 穿墙惩罚
    globalC?: number;      // 全局临界力常数 C（默认 1.0）
}

function normalizeSolverOptions(options: SolverOptions): Required<SolverOptions> {
    return {
        damping: options.damping ?? 0.6,
        maxIter: options.maxIter ?? 100,
        eps: options.eps ?? 1e-2,
        crossPunish: options.crossPunish ?? DEFAULT_CROSS_PUNISH,
        globalC: options.globalC ?? DEFAULT_F,
    };
}

export interface HorizontalLayoutHookContext {
    readonly columns: LayoutElement[][]; // 完整归一化矩阵，用于查看区间外邻居
    readonly rows: number;               // fillPlaceholders 得到的 Track 行数
    readonly start: number;
    readonly end: number;
    readonly X: Float64Array;             // 全行列坐标
    readonly fixed: Uint8Array;
    readonly options: Required<SolverOptions>;
}

export type HorizontalLayoutHook = (context: HorizontalLayoutHookContext) => void;

export interface HorizontalLayoutHookEntry {
    readonly start: number;
    readonly end: number;
    readonly hook: HorizontalLayoutHook;
}

/** 不处理 fixed 和写回，只求一组普通列的 anchor 坐标；返回自然布局是否有余量 */
function solveHorizontal(
    mat: LayoutElement[][],
    rows: number,
    X: Float64Array,
    limit: number,
    options: Required<SolverOptions>,
): boolean {
    const { damping, maxIter, eps, crossPunish } = options;
    const numCols = mat.length;
    // if (numCols === 0 || rows === 0) return false; layoutHorizontalRegion 已经判断过了

    // 预排列（仅用前 rows 个元素建立无约束时的位置）
    const row_x = new Float64Array(rows);
    for (let c = 0; c < numCols; c++) {
        let x = 0;
        const col = mat[c];
        for (let r = 0; r < rows; r++) {
            const required_x = row_x[r] + col[r].WL + col[r].margin_L;
            if (required_x > x) x = required_x;
        }
        for (let r = 0; r < rows; r++) {
            row_x[r] = x + col[r].WR + col[r].margin_R;
        }
        X[c] = x;
    }
    let x0 = row_x.reduce((a, b) => Math.max(a, b), 0); // 预排列后的总宽度

    if (x0 <= limit) return true;   // 空间充足，无需迭代
    // 如果预排列就已经超出限制了，则直接等比压缩到限制范围内
    x0 = limit / x0;
    for (let c = 0; c < numCols; c++) X[c] *= x0;

    // --- 预分配物理引擎所需的全部静态缓存空间，杜绝主循环内的 GC 损耗 ---
    const F_vec = new Float64Array(numCols);
    const stiffnessCache = new Float32Array(rows * (numCols + 1));
    // 计算全局合力，并就地填充刚度缓存
    function computeForces(cols_X: Float64Array): Float64Array {
        F_vec.fill(0);
        for (let r = 0; r < rows; r++) {
            const rowOffset = r * (numCols + 1);
            // 左墙
            const el_first = mat[0][r];
            const res_left = calcLeftWall(el_first, cols_X[0], crossPunish);
            F_vec[0] += res_left.force;
            stiffnessCache[rowOffset] = res_left.stiffness; // 缓存左墙刚度

            // 内部链弹簧力传导
            for (let c = 1; c < numCols; c++) {
                const el_l = mat[c - 1][r];
                const el_r = mat[c][r];
                const res = calcPairForceAndStiffness(el_l, el_r, cols_X[c - 1], cols_X[c]);
                F_vec[c - 1] -= res.force;
                F_vec[c] += res.force;
                stiffnessCache[rowOffset + c] = res.stiffness; // 缓存链弹簧刚度
            }

            // 右墙
            const el_last = mat[numCols - 1][r];
            const res_right = calcRightWall(el_last, cols_X[numCols - 1], limit, crossPunish);
            F_vec[numCols - 1] -= res_right.force;
            stiffnessCache[rowOffset + numCols] = res_right.stiffness; // 缓存右墙刚度
        } return F_vec;
    }

    const Hp = new Float64Array(numCols);
    // Hessian 矩阵切向刚度乘以位移向量 p (精简参数，移除了无用的 cols_X)
    function multiplyH(p: Float64Array): Float64Array {
        Hp.fill(0);
        for (let r = 0, rowOffset = 0; r < rows; r++, rowOffset += (numCols + 1)) {
            // 左墙刚度
            Hp[0] += stiffnessCache[rowOffset] * p[0];
            // 链弹簧二阶切线刚度
            for (let c = 1; c < numCols; c++) {
                const Kdp = stiffnessCache[rowOffset + c] * (p[c] - p[c - 1]);
                Hp[c - 1] -= Kdp;
                Hp[c] += Kdp;
            }
            // 右墙刚度
            Hp[numCols - 1] += stiffnessCache[rowOffset + numCols] * p[numCols - 1];
        }
        // L-M 正则阻尼，保证矩阵严格正定，避免奇异性
        const lambda = 1e-4;
        for (let i = 0; i < p.length; i++) Hp[i] += lambda * p[i];
        return Hp;
    }

    function dot(a: Float64Array, b: Float64Array): number {
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
        return sum;
    }

    // 必须用 Float64Array 不然影响收敛
    const dx = new Float64Array(numCols);
    const R = new Float64Array(numCols);
    const P = new Float64Array(numCols);
    // 共轭梯度线性解算
    function solveCG(F_vec: Float64Array, maxCGIter = 8): Float64Array {
        dx.fill(0);
        R.set(F_vec);
        P.set(R);

        let rsold = dot(R, R);
        if (rsold < 1e-12) return dx;

        for (let iter = 0; iter < maxCGIter; iter++) {
            const Hp = multiplyH(P);
            const p_Hp = dot(P, Hp);
            if (Math.abs(p_Hp) < 1e-12) break;

            const alpha = rsold / p_Hp;
            for (let i = 0; i < numCols; i++) {
                dx[i] += alpha * P[i];
                R[i] -= alpha * Hp[i];
            }

            const rsnew = dot(R, R);
            if (Math.sqrt(rsnew) < 1e-6) break;

            const beta = rsnew / rsold;
            for (let i = 0; i < numCols; i++) {
                P[i] = R[i] + beta * P[i];
            } rsold = rsnew;
        } return dx;
    }

    // 主物理迭代牛顿步
    let turn = 0, f_max = 0;
    for (; turn < maxIter; turn++) {
        const F_vec = computeForces(X);
        f_max = 0;
        for (let i = 0; i < F_vec.length; i++) {
            const absf = Math.abs(F_vec[i]);
            if (absf > f_max) f_max = absf;
        }
        if (f_max < eps) break;
        const dx = solveCG(F_vec);
        for (let i = 0; i < numCols; i++) {
            X[i] += damping * dx[i];
        }
    }
    return false;
}

/**
 * 在一段已经归一化的列上排版
 *
 * @param columns 当前区间的归一化列矩阵，列数必须等于 X.length
 * @param rows fillPlaceholders 得到的 Track 数；每列超出 rows 的元素不参与求解
 * @param X 当前区间的 anchor 坐标；通常是全行 X 的 subarray。是求解结果
 * @param fixed 当前区间的 gap 是否已经固定，长度必须为 X.length - 1；通常是全行 fixed 的 subarray。fixed[i]==1 表示第 i、i+1 列只能整体移动
 * @param limit 当前区间左右墙之间的可用宽度
 * @param options 已补齐默认值的求解参数
 * @param fill 空间有余量时，是否让首尾贴墙并把余量平均分到自由间隙
 */
export function layoutHorizontalRegion(
    columns: LayoutElement[][],
    rows: number,
    X: Float64Array,
    fixed: Uint8Array,
    limit: number,
    options: Required<SolverOptions>,
    fill = false,
): void {
    if (X.length !== columns.length || fixed.length !== Math.max(0, X.length - 1)) {
        throw new Error("Horizontal region state does not match its columns");
    }
    if (X.length === 0 || rows === 0) return;

    const hasFixed = fixed.some(value => value !== 0);
    let groupOf, offsets;
    let solvedColumns = columns;
    let solvedX = X;

    if (hasFixed) { // 先把连续的固定列合并为虚拟列，求解后再拆开
        groupOf = new Uint32Array(X.length);    // 记录每个列属于哪一组
        offsets = new Float64Array(X.length);   // 记录每个列相对于组首的偏移量
        solvedColumns = [];
        for (let start = 0; start < X.length;) {
            // 找连续的固定列区间
            let end = start;
            while (end < fixed.length && fixed[end]) end++;
            const groupIndex = solvedColumns.length;
            for (let i = start; i <= end; i++) {
                groupOf[i] = groupIndex;
                offsets[i] = X[i] - X[start];
            }

            if (start === end) solvedColumns.push(columns[start]);
            else {
                const span = X[end] - X[start];
                // 合并为虚拟的一列
                solvedColumns.push(Array.from({ length: rows }, (_, row): LayoutElement => {
                    const left = columns[start][row];
                    const right = columns[end][row];
                    return {
                        config: {
                            alpha_L: left.config.alpha_L,
                            alpha_R: right.config.alpha_R,
                            mu_L: left.config.mu_L,
                            mu_R: right.config.mu_R,
                            beta_L: left.config.beta_L,
                            beta_R: right.config.beta_R,
                        },
                        box: left.box,  // 虚拟元素不写回，仅用于满足 LayoutElement，算法不会读取
                        time: left.time,
                        duration_L: left.duration_L,
                        duration_R: right.duration_R,
                        WL: left.WL,
                        WR: span + right.WR,
                        margin_L: left.margin_L,
                        margin_R: right.margin_R,
                        fake: left.fake && right.fake,
                    };
                }));
            }
            start = end + 1;
        }
        solvedX = new Float64Array(solvedColumns.length);
    }

    const hasRoom = solveHorizontal(solvedColumns, rows, solvedX, limit, options);
    fixed.fill(1);

    if (fill && hasRoom) {
        // 让首尾贴墙，并把余量平均分到自由间隙
        let leftWidth = 0;
        let rightWidth = 0;
        for (let row = 0; row < rows; row++) {
            leftWidth = Math.max(leftWidth, solvedColumns[0][row].WL);
            rightWidth = Math.max(rightWidth, solvedColumns[solvedColumns.length - 1][row].WR);
        }
        const shift = leftWidth - solvedX[0];
        const extra = limit - rightWidth - solvedX[solvedX.length - 1] - shift;
        for (let i = 0; i < solvedX.length; i++) {
            solvedX[i] += shift + (extra > 0 && solvedX.length > 1
                ? extra * i / (solvedX.length - 1)
                : 0);
        }
    }

    if (hasFixed) { // 把虚拟列的求解结果写回原始列
        for (let i = 0; i < X.length; i++) X[i] = solvedX[groupOf![i]] + offsets![i];
    }
}

/**
 * 纯扁平化物理排版解算入口
 *
 * @param columns 二维数组，第一维为列，第二维为行，元素包含物理属性和状态属性
 * @param limit 宽度约束
 * @param options 排版物理配置
 * @returns 同一个解算完成的二维矩阵，所有盒子的绝对 box.x (左侧x坐标) 已就地更新
 */
export function layoutHorizontal(
    columns: LayoutElement[][],
    limit: number,
    options: SolverOptions = {},
    horizontalLayoutHooks: readonly HorizontalLayoutHookEntry[] = [],
): LayoutElement[][] {
    const normalizedOptions = normalizeSolverOptions(options);
    const { mat, rows } = fillPlaceholders(columns, normalizedOptions.globalC);
    const X = new Float64Array(mat.length);
    const fixed = new Uint8Array(Math.max(0, mat.length - 1));

    const ordered = horizontalLayoutHooks.length > 1
        ? [...horizontalLayoutHooks].sort((a, b) => (a.end - a.start) - (b.end - b.start))
        : horizontalLayoutHooks;
    for (const { start, end, hook } of ordered) {
        if (start < 0 || end < start || end >= mat.length) {
            throw new Error("Horizontal layout registration references invalid columns");
        }
        hook({
            columns: mat, rows,
            start, end,
            X, fixed,
            options: normalizedOptions,
        });
    }
    layoutHorizontalRegion(mat, rows, X, fixed, limit, normalizedOptions);

    // 坐标写回
    for (let c = 0; c < mat.length; c++) {
        for (const el of mat[c]) el.box.x = X[c] - el.box.anchor;
    }
    return mat;
}