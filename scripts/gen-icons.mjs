// Rasterize assets/icons/fastterminal.svg into PNG sizes and build/icon.ico
import sharp from 'sharp'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = join(root, 'assets/icons/fastterminal.svg')
const iconsDir = join(root, 'assets/icons')
const buildDir = join(root, 'build')

const svg = await readFile(svgPath)
const sizes = [16, 32, 64, 128, 256, 512, 1024]

if (!existsSync(buildDir)) await mkdir(buildDir, { recursive: true })

for (const size of sizes) {
  const out = join(iconsDir, `fastterminal-${size}.png`)
  await sharp(svg).resize(size, size).png().toFile(out)
  console.log('wrote', out)
}

// Build multi-resolution ICO for Windows.
// Strategy: generate PNG buffers at 16, 32, 48, 64, 128, 256 and stitch an ICO.
const icoSizes = [16, 32, 48, 64, 128, 256]
const pngs = await Promise.all(
  icoSizes.map((s) => sharp(svg).resize(s, s).png().toBuffer().then((buf) => ({ size: s, buf })))
)

function toIco(entries) {
  // ICONDIR: 6 bytes
  const headerLen = 6
  const entryLen = 16
  const numImages = entries.length
  const header = Buffer.alloc(headerLen + entryLen * numImages)
  header.writeUInt16LE(0, 0)           // reserved
  header.writeUInt16LE(1, 2)           // type = 1 (icon)
  header.writeUInt16LE(numImages, 4)   // count

  let offset = headerLen + entryLen * numImages
  const bodies = []
  entries.forEach((e, i) => {
    const eo = headerLen + entryLen * i
    const size = e.size === 256 ? 0 : e.size  // 0 means 256
    header.writeUInt8(size, eo + 0)    // width
    header.writeUInt8(size, eo + 1)    // height
    header.writeUInt8(0,    eo + 2)    // palette
    header.writeUInt8(0,    eo + 3)    // reserved
    header.writeUInt16LE(1, eo + 4)    // color planes
    header.writeUInt16LE(32, eo + 6)   // bits per pixel
    header.writeUInt32LE(e.buf.length, eo + 8)  // bytes
    header.writeUInt32LE(offset, eo + 12)       // offset
    bodies.push(e.buf)
    offset += e.buf.length
  })

  return Buffer.concat([header, ...bodies])
}

const ico = toIco(pngs)
const icoPath = join(buildDir, 'icon.ico')
await writeFile(icoPath, ico)
console.log('wrote', icoPath, ico.length, 'bytes')
