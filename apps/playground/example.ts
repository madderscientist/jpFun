/**
 * 预览工具的默认谱例
 */
export const PLAYGROUND_EXAMPLE = `% ===== jpFun 语法示例 ===== %
@page(width=860px, height=0px, top=42px, bottom=42px, left=38px, right=38px, gap=1.2em, numbering="1 / 1")

H.title: jpFun 简谱示例
H.subtitle: 函数式排版语言
H.author: 示例曲谱
H.author: madderscientist 开发
H.signature: 1=C 4/4
H.tempo: 94

@text("音符 ")
@note(C, #, 4, #f00) % 标准函数调用
C3#           % 绝对音高语法糖：音名+升降号+八度
n1,,  #2  b3' % 相对音高语法糖
0 8 9         % 休止符、隐形占位、节拍记号

@text("时值 ")
@div(F#3, 2) % 减时线 标准函数调用
@dot(G#5, 2) % 附点 标准函数调用
@dash()      % 增时线
9//./. -     % 语法糖

@text("小节线 ")
@bar()  % 小节线 标准函数调用
|  ||  |:  :|  :|:  % 小节线语法糖

@text("反复与房子 ")
|: 1 2 3 4 | 5@h1a 6 7 1'@h1b :| 1'@h2a 7 6 5@h2b | 1 - - - ||  % 播放两遍，各走一个房子；末尾一小节在房子外面
@volta(h1a, h1b, 1)  @volta(h2a, h2b, 2)  % 房子用首末音符的标签划区间，因此能横跨谱面行

@text("多声部与歌词 ")
@voices(
    @voice({1 2 3 4}, 第一轨, 歌词="do re mi fa"),
    @voice({5 6 7 8}, , "无名歌词", 有名歌词="so la ti do"),
)
N(语法糖): 1/ 1/ 5/ 5/ 6/ 6/ 5
L(歌词): 一闪一闪亮晶晶
N: 5/ 5/ 4/ 4/ 3/ 3/ 2
L: 满天都是小星星

@text("临时多声部 ")
@stack({1/, 2}, {4/ 6})
{1./ 2} & {3 4./}   % 语法糖

@text("和弦 ")
@up(C4, E4, G4) % 标准函数调用
2, ^ 4' ^ 6     % 语法糖

@text(倚音)
@grace(C4, D4, pre) @grace(E4, F4, post) % 标准函数调用
1 > {2 < 4} > 3 > 4 < 3 > 5 < 6 < 7 % 语法糖

@text("延音线")
1@x 2 3@a 4@y @arp(5^6@b) @tie(a, b) @tie(x, y) % 需要打标签

@text("符号")
$ppp $pp $p $mp $mf $f $ff $fff $segno $ds $dc $fine $mordent $prall $tr $accent

@text("其他函数与混用：")

@1(D4)  % 设置调性
N: @set(note.color=#f0f) @box({#1,// n2/ b3'.-}, padding=0.2em)
N: F7#/^@text(D调的F#) {5@x 6/@y} & {6/^$tr {7_$p}<#4} C3/ ^ E3
@tie(x,y)
`;