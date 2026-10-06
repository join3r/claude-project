import React, { useCallback, useState } from 'react'
import { X } from 'lucide-react'
import type { ChatImage } from '../../../shared/claude-chat'

/**
 * Images pasted or dropped into a prompt box, held until the message goes. Shared
 * by the chat composer and the boxes that start a chat (New task, an empty task),
 * so an image attaches the same way wherever Claude is about to read it.
 */

export interface Attachment extends ChatImage {
  id: string
  preview: string
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export function readImage(file: File): Promise<Attachment | null> {
  if (!file.type.startsWith('image/') || file.size > MAX_IMAGE_BYTES) return Promise.resolve(null)
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result ?? '')
      const comma = url.indexOf(',')
      if (comma < 0) return resolve(null)
      resolve({ id: `${Date.now()}-${Math.random()}`, mediaType: file.type, data: url.slice(comma + 1), preview: url })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** What goes over the wire: the image without its id and preview. */
export function toChatImages(images: readonly Attachment[]): ChatImage[] {
  return images.map(({ mediaType, data }) => ({ mediaType, data }))
}

export interface ImageAttachments {
  images: Attachment[]
  addFiles: (list: FileList | File[]) => Promise<void>
  remove: (id: string) => void
  clear: () => void
  /** For the textarea: a pasted image attaches instead of pasting nothing. */
  onPaste: (e: React.ClipboardEvent) => void
  /** For the box around it: files dropped anywhere on it attach. */
  dropProps: {
    onDragOver: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

/** `enabled` false ignores pastes and drops, leaving them to the browser. */
export function useImageAttachments(enabled = true): ImageAttachments {
  const [images, setImages] = useState<Attachment[]>([])

  const addFiles = useCallback(async (list: FileList | File[]): Promise<void> => {
    const read = await Promise.all(Array.from(list).map(readImage))
    const ok = read.filter((a): a is Attachment => a !== null)
    if (ok.length) setImages((prev) => [...prev, ...ok])
  }, [])
  const remove = useCallback((id: string) => setImages((prev) => prev.filter((i) => i.id !== id)), [])
  const clear = useCallback(() => setImages([]), [])

  const onPaste = (e: React.ClipboardEvent): void => {
    if (!enabled) return
    const pasted = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith('image/'))
    if (pasted.length > 0) {
      e.preventDefault()
      void addFiles(pasted)
    }
  }

  const dropProps = {
    onDragOver: (e: React.DragEvent): void => {
      if (enabled && e.dataTransfer.types.includes('Files')) e.preventDefault()
    },
    onDrop: (e: React.DragEvent): void => {
      if (!enabled || e.dataTransfer.files.length === 0) return
      e.preventDefault()
      void addFiles(e.dataTransfer.files)
    }
  }

  return { images, addFiles, remove, clear, onPaste, dropProps }
}

/** Thumbnails of the attached images, each with a remove button on hover. */
export function AttachmentStrip({ images, onRemove }: { images: readonly Attachment[]; onRemove: (id: string) => void }): React.ReactElement | null {
  if (images.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
      {images.map((image) => (
        <div key={image.id} className="relative group">
          <img src={image.preview} alt="" className="h-14 w-14 object-cover rounded-md border-[0.5px] border-border" />
          <button
            type="button"
            title="Remove"
            aria-label="Remove image"
            onClick={() => onRemove(image.id)}
            className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full border-0 bg-surface-3 text-text flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>
  )
}
