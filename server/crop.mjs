import sharp from "sharp";
await sharp("D:/project/files/tmp/badge-check.png")
  .extract({ left: 320, top: 150, width: 900, height: 340 })
  .toFile("D:/project/files/tmp/badge-check-crop.png");
await sharp("D:/project/files/tmp/badge-check.png")
  .extract({ left: 320, top: 480, width: 900, height: 220 })
  .toFile("D:/project/files/tmp/badge-long.png");
console.log("ok");
