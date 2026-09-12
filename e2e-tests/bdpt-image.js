import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";

export const attachBdptComparisonImage = async (page, result, testInfo) => {
  const png = await page.evaluate(
    ({ width, height, image, referenceImage, label }) => {
      const canvas = document.createElement("canvas");
      canvas.width = (width * 2 + 4) * 6;
      canvas.height = height * 6 + 24;
      const context = canvas.getContext("2d");
      context.fillStyle = "#222";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = false;
      [image, referenceImage].forEach((values, index) => {
        const source = document.createElement("canvas");
        source.width = width;
        source.height = height;
        const sourceContext = source.getContext("2d");
        const pixels = sourceContext.createImageData(width, height);
        for (let pixel = 0; pixel < width * height; pixel++) {
          for (let channel = 0; channel < 3; channel++) {
            const value = values[pixel * 3 + channel];
            pixels.data[pixel * 4 + channel] =
              255 * Math.pow(value / (1 + value), 1 / 2.2);
          }
          pixels.data[pixel * 4 + 3] = 255;
        }
        sourceContext.putImageData(pixels, 0, 0);
        const x = index * (width + 4) * 6;
        context.drawImage(source, x, 24, width * 6, height * 6);
        context.fillStyle = "white";
        context.fillText(index === 0 ? label : "Reference PT", x, 15);
      });
      return canvas.toDataURL("image/png").split(",")[1];
    },
    result,
  );
  const path = testInfo.outputPath("bdpt-initial-reference.png");
  await writeFile(path, Buffer.from(png, "base64"));
  await testInfo.attach("bdpt-initial-reference", {
    path,
    contentType: "image/png",
  });
};
