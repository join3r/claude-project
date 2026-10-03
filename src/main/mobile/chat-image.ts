import type { ChatImage } from '../../shared/claude-chat'
import { ChatLimits, type ChatImageResult } from '../../../protocol/ts/index.ts'

/**
 * `chat.image` (protocol/SPEC.md §8.9): a tool-result image made small enough for
 * the phone. Pure apart from the codec, which main backs with Electron's
 * `nativeImage` (image-codec.ts) and tests with a fake.
 */

export interface DecodedImage {
  width: number
  height: number
  resize(width: number, height: number): DecodedImage
  png(): Buffer
  jpeg(quality: number): Buffer
}

export interface ImageCodec {
  /** Null when the bytes can't be decoded. */
  decode(bytes: Buffer): DecodedImage | null
}

const JPEG_QUALITIES = [85, 70, 55]
/** Each further try scales the longest side by this. */
const SHRINK = 0.7

export class ImageTooLargeError extends Error {}

/**
 * The image scaled down to `maxSide` (never up) and encoded to at most
 * `maxChars` base64 characters. The original bytes go as they are when they
 * already fit both; otherwise the type is kept when the result fits, then JPEG
 * at falling quality, then smaller and smaller sizes.
 */
export function fitImage(
  image: ChatImage,
  maxSide: number,
  codec: ImageCodec,
  maxChars: number = ChatLimits.imageData
): ChatImageResult {
  const bytes = Buffer.from(image.data, 'base64')
  const decoded = codec.decode(bytes)
  if (!decoded || decoded.width <= 0 || decoded.height <= 0) {
    if (image.data.length <= maxChars) return { mediaType: image.mediaType, data: image.data }
    throw new ImageTooLargeError('The image is too large to send and could not be resized')
  }
  const longest = Math.max(decoded.width, decoded.height)
  if (longest <= maxSide && image.data.length <= maxChars) return { mediaType: image.mediaType, data: image.data }

  let side = Math.min(longest, maxSide)
  for (;;) {
    const scaled = scaleTo(decoded, side)
    // PNG keeps transparency and sharp text; JPEG only when that is too big.
    if (image.mediaType !== 'image/jpeg') {
      const png = scaled.png().toString('base64')
      if (png.length <= maxChars) return { mediaType: 'image/png', data: png }
    }
    for (const quality of JPEG_QUALITIES) {
      const jpeg = scaled.jpeg(quality).toString('base64')
      if (jpeg.length <= maxChars) return { mediaType: 'image/jpeg', data: jpeg }
    }
    if (side <= ChatLimits.imageMinSide) throw new ImageTooLargeError('The image is too large to send')
    side = Math.max(ChatLimits.imageMinSide, Math.floor(side * SHRINK))
  }
}

function scaleTo(image: DecodedImage, side: number): DecodedImage {
  const longest = Math.max(image.width, image.height)
  if (longest <= side) return image
  const ratio = side / longest
  return image.resize(Math.max(1, Math.round(image.width * ratio)), Math.max(1, Math.round(image.height * ratio)))
}
