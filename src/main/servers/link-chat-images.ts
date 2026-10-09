import type { ChatImage } from '../../shared/claude-chat'
import { ChatLimits } from '../../../protocol/ts/index.ts'
import { fitImage, type ImageCodec } from '../mobile/chat-image'

/**
 * Base64 characters the images of one `chat-send` to a DevTool server may take.
 * A host link message is at most 4 MiB (protocol/SERVER.md §4), and a composer
 * takes images up to 5 MB each, so a pasted screenshot or two would not fit.
 */
export const LINK_CHAT_IMAGES_BUDGET = 3_000_000

/**
 * A server chat's images, made to fit one host link message: as they are when
 * they already fit together, else each scaled down (this desktop has the image
 * codec; a server's passes images through) to its share of the budget. Throws
 * `ImageTooLargeError` for an image that can't be made small enough.
 */
export function fitChatImagesForLink(
  images: readonly ChatImage[] | undefined,
  codec: ImageCodec,
  budget: number = LINK_CHAT_IMAGES_BUDGET
): ChatImage[] {
  const plain = (images ?? []).map(({ mediaType, data }) => ({ mediaType, data }))
  const total = plain.reduce((sum, image) => sum + image.data.length, 0)
  if (total <= budget) return plain
  const share = Math.floor(budget / plain.length)
  return plain.map((image) => {
    const fitted = fitImage(image, ChatLimits.imageDefaultSide, codec, share)
    return { mediaType: fitted.mediaType, data: fitted.data }
  })
}
