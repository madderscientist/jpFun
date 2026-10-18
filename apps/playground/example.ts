/**
 * 预览工具的默认谱例
 */
export const PLAYGROUND_EXAMPLE = `% ===== jpFun 语法示例 ===== %
@page(width=860px, height=0px, top=42px, bottom=42px, left=38px, right=38px, gap=1.2em, numbering="1 / 1", fillRatio=0.7)

H.title: jpFun 简谱示例
H.subtitle: 函数式排版语言
H.author: 示例曲谱
H.author: madderscientist 开发
H.signature: 1=C 4/4
H.tempo: 94

@text("音符 ")
@note(C, #, 4, #f00) % 标准函数调用（别名 @n）
C3#           % 绝对音高语法糖：音名+升降号+八度
n1,,  #2  b3' % 相对音高语法糖
(5)  [6]      % JE 兼容：() 低八度、[] 高八度
0 Z  8  9 X   % 休止符（0/Z）、隐形占位（8）、节拍记号（9/X）

@text("时值与连音 ")
@div(F#3, 2) % 减时线 标准函数调用（别名 @/）
@dot(G#5, 2) % 附点 标准函数调用（别名 @.）
@dash()      % 增时线（别名 @-）
9//./. -     % 语法糖
@div({1 2}, autobeam=false)  1/@b1 2/@b2 @beam(b1, b2) % 断开自动连线与手动连线
@tuplet({1/ 2/ 3/}, 2)  @tuplet({1/ 2 3}, 4) % 多连音（三连音、五连音）

@text("小节线与整小节休止 ")
@bar()  % 小节线 标准函数调用（别名 @|）
|  ||  |||  |:  :|  :|:  % 小节线语法糖
@rest(4) |               % 多小节休止

@text("反复与房子 ")
|: 1 2 3 4 | 5@h1a 6 7 1'@h1b :| 1'@h2a 7 6 5@h2b | 1 - - - |||  % 播放两遍，各走一个房子；末尾一小节在房子外面
@volta(h1a, h1b, 1)  @volta(h2a, h2b, 2)  % 房子用首末音符的标签划区间，因此能横跨谱面行

@text("八度号 ")
5,/@oa 6,/ 1/ 2/ | 5 -@ob | @ottava(oa, ob)
5'/@oc 6'/ 1/ 2/ | 5 -@od | @ottava(oc, od, -1)
1@oe 2 3 4@of | @ottava(oe, of, 2)   % 高两个八度，标 15
1@og 2 3 4@oh | @ottava(og, oh, -3)  % 低三个八度，标 22

@text("多声部与歌词 ")
@voices(
    @voice({1 2 3 4}, 第一轨, 歌词="do re mi fa"),
    @voice({5 6 7 8}, , "无名歌词", 有名歌词="{一音多字} @ @"),
    connect="{1-2}"
)
V[]:
N(语法糖): 1/ 1/ 5/ 5/ 6/ 6/ 5
L(歌词): 一闪一闪亮晶晶，
N: 5/ 5/ 4/ 4/ 3/ 3/ 2
L: 满天都是小星星。

@text("临时多声部 ")
@stack({1/, 2}, {4/ 6})
{1./ 2} & {3 4./}   % 语法糖

@text("和弦与琶音 ")
@up(C4, E4, G4)  @down(C4, G3) % 上下堆叠 标准函数调用
2, ^ 4' ^ 6      5 _ 3 _ 1     % 语法糖 ^ 与 _
@arp(1 ^ 3 ^ 5)  @arp(1 ^ 3 ^ 5, up)  @arp(1 ^ 3 ^ 5, down) % 琶音（别名 @arpeggio）

@text("倚音与滑音 ")
@grace(C4, D4, pre) @grace(E4, F4, post) % 倚音 标准函数调用
1 > {2 < 4} > 3 > 4 < 3 > 5 < 6 < 7      % 倚音语法糖
@slide(5)  @slide(5, direction=down)  @slide(5, side=post)  @slide(5, post, down) % 装饰滑音

@text("延音线与滑音连线 ")
1@ 2@ @tie()
1@x 2 3@a 4@y @arp(5^6@b) @tie(a, b) @tie(x, y, height=1em) % 相邻简写与标签指定
1@g1 5@g2 2@g3 @gliss(g1, g2) @gliss(g3, g2)                  % 两音间的滑音连线

@text("渐强与渐弱 ")
1 ^ $p 2@d1 3 5@d2 @dyn(d1, d2, 24)  5 ^ $f 3@d3 2 1@d4 @dyn(d3, d4, -24)

@text("符号 ")
@symbol(fermata) $ppp $pp $p $mp $mf $f $ff $fff $segno $ds $dc $fine $mordent $prall $tr $tr+++ $accent

@text("其他函数与混用：")

@1(D4) @meter(0, 4)  % 设置调性（@key/@1）与散板拍号（@meter）
N: {
  @program(40) @set(note.color=#f0f)
  @box({
    #1,// n2/ b3'. -
  }, padding=0.2em) @adjust(5 ^ "微调高度", dy=-10px)
}
N: @instrument(73) F7#/^@text(D调的F#) {5@tx 6/@ty} & {6/^$tr++ {7_$p}<#4} {C3/ ^ E3 ^ @tempo(120)} @tie(tx, ty)
% 排版控制：顶层空行等价于 @br() 换行；@pagebreak()（别名 @pb）可强制换页
`;