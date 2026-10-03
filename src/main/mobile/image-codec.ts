import { nativeImage, type NativeImage } from 'electron'
import type { DecodedImage, ImageCodec } from './chat-image'

/** {@link ImageCodec} on Electron's `nativeImage` (PNG and JPEG out; it reads what Chromium reads). */
export const nativeImageCodec: ImageCodec = {
  decode(bytes) {
    const image = nativeImage.createFromBuffer(bytes)
    return image.isEmpty() ? null : wrap(image)
  }
}

function wrap(image: NativeImage): DecodedImage {
  const { width, height } = image.getSize()
  return {
    width,
    height,
    resize: (w, h) => wrap(image.resize({ width: w, height: h, quality: 'good' })),
    png: () => image.toPNG(),
    jpeg: (quality) => image.toJPEG(quality)
  }
}
