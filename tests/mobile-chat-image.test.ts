import { describe, expect, it } from 'vitest'
import { fitImage, type DecodedImage, type ImageCodec } from '../src/main/mobile/chat-image'
import type { ChatImage } from '../src/shared/claude-chat'

/**
 * A fake codec: an "image" is the JSON `{ w, h }`. PNG costs one byte per pixel and
 * JPEG a quarter of that at quality 100, so sizes are easy to reason about.
 */
const fakeCodec: ImageCodec & { resizes: [number, number][] } = {
  resizes: [],
  decode(bytes) {
    try {
      const { w, h } = JSON.parse(bytes.toString()) as { w: number; h: number }
      return image(w, h)
    } catch {
      return null
    }
  }
}

function image(width: number, height: number): DecodedImage {
  return {
    width,
    height,
    resize: (w, h) => {
      fakeCodec.resizes.push([w, h])
      return image(w, h)
    },
    png: () => Buffer.alloc(width * height),
    jpeg: (quality) => Buffer.alloc(Math.ceil((width * height * quality) / 400))
  }
}

function source(w: number, h: number, mediaType = 'image/png'): ChatImage {
  return { mediaType, data: Buffer.from(JSON.stringify({ w, h })).toString('base64') }
}

const base64Chars = (bytes: number): number => Math.ceil(bytes / 3) * 4

describe('fitImage (chat.image, SPEC.md §8.9)', () => {
  it('sends the original bytes when they fit the side and the size cap', () => {
    fakeCodec.resizes = []
    const src = source(800, 600, 'image/gif')
    expect(fitImage(src, 2048, fakeCodec)).toEqual(src)
    expect(fakeCodec.resizes).toEqual([])
  })

  it('scales the longest side down to maxSide and keeps PNG when it fits', () => {
    fakeCodec.resizes = []
    const out = fitImage(source(1000, 500), 400, fakeCodec)
    expect(fakeCodec.resizes).toEqual([[400, 200]])
    expect(out.mediaType).toBe('image/png')
    expect(out.data.length).toBe(base64Chars(400 * 200))
  })

  it('falls back to JPEG, then to smaller sizes, until it fits the cap', () => {
    fakeCodec.resizes = []
    // PNG at 900×900 is 810 kB; the cap allows 200000 base64 chars, which JPEG at 70 meets.
    const jpeg = fitImage(source(1000, 1000), 900, fakeCodec, 200_000)
    expect(jpeg.mediaType).toBe('image/jpeg')
    expect(jpeg.data.length).toBeLessThanOrEqual(200_000)

    fakeCodec.resizes = []
    const small = fitImage(source(4000, 4000, 'image/jpeg'), 3000, fakeCodec, 200_000)
    expect(small.mediaType).toBe('image/jpeg')
    expect(small.data.length).toBeLessThanOrEqual(200_000)
    expect(fakeCodec.resizes.length).toBeGreaterThan(1)
  })

  it('sends undecodable bytes as they are when they fit, and refuses them when they do not', () => {
    const odd: ChatImage = { mediaType: 'image/webp', data: Buffer.from('not an image').toString('base64') }
    expect(fitImage(odd, 2048, fakeCodec)).toEqual(odd)
    expect(() => fitImage(odd, 2048, fakeCodec, 4)).toThrow(/too large/)
  })
})
