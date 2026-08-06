#!/usr/bin/env node

import sharp from "sharp";

const [, , input, output] = process.argv;

if (!input || !output) {
  console.error("Usage: node scripts/generate-pwa-icon.mjs <input> <output>");
  process.exit(1);
}

await sharp(input)
  .resize(384, 384, { fit: "inside" })
  .flatten({ background: "white" })
  .extend({
    top: 64,
    bottom: 64,
    left: 64,
    right: 64,
    background: "white",
  })
  .removeAlpha()
  .png()
  .toFile(output);
