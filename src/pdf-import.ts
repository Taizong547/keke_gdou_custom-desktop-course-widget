import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'

// Same-origin worker 以满足 Tauri CSP
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()

const MAX_PDF_BYTES = 40 * 1024 * 1024
const RENDER_SCALE = 2.5

export type RenderedPdfPage = {
  dataUrl: string
  pageNumber: number
  pageCount: number
}

// 将 PDF 每页渲染为 PNG，供本地 OCR 使用；未选择文件时返回空数组
export async function choosePdfFile(): Promise<{ name: string; pages: RenderedPdfPage[] } | null> {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.pdf,application/pdf'
  const picked = await new Promise<File | null>((resolve) => {
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null)
    })
    input.click()
  })
  if (!picked) return null
  if (picked.size > MAX_PDF_BYTES) {
    throw new Error('PDF 文件过大（超过 40MB）')
  }

  const buffer = await picked.arrayBuffer()
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) })
  const pdfDocument = await loadingTask.promise
  try {
    const pages: RenderedPdfPage[] = []
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber)
      const viewport = page.getViewport({ scale: RENDER_SCALE })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建 PDF 渲染画布')
      await page.render({ canvasContext: context, viewport }).promise
      pages.push({
        dataUrl: canvas.toDataURL('image/png'),
        pageNumber,
        pageCount: pdfDocument.numPages,
      })
      page.cleanup()
    }
    return { name: picked.name, pages }
  } finally {
    void loadingTask.destroy()
  }
}
