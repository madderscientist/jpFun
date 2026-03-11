import { preprocessSource } from "../parser/preprocess";

const source = [
    "line-a \\\\",
    "line-b",
    "line-c \\   \t",
    "line-d",
    "line-e \\% trailing comment",
    "line-f",
    "line-g % comment only \\",
    "line-h \\% comment with escaped backslash \\\\",
    "line-i \"100% in string\" % comment after string \\",
    "line-j \\\\\\",
    "line-k \\\\% comment with escaped backslash \\\\",
    "end"
].join("\n");

const { maskedSource, lineStarts } = preprocessSource(source);

console.log("=== before ===");
console.log(source);
console.log(source.length);
console.log("=== after ===");
console.log(maskedSource);
console.log(maskedSource.length);
console.log("=== escaped(after) ===");
console.log(JSON.stringify(maskedSource));
console.log("=== lineStarts ===");
console.log(lineStarts.join(", "));
