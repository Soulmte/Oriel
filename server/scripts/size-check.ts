import { measureDirectories, measureDirectory } from "../src/lib/file-info.js";
console.log("single:", JSON.stringify(await measureDirectory("D:\\project\\files\\src")));
console.log("batch:", JSON.stringify(await measureDirectories(["D:\\project\\files\\src", "C:\\Windows\\Help"])));
