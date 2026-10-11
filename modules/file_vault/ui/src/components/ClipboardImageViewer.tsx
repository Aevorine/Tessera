import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Copy, Maximize2, Minimize2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  clampZoom,
  saveClipboardImageViewMode,
  zoomByWheel,
  type ClipboardImageViewMode,
} from '@/lib/clipboardImagePrefs'

export interface ViewerImage {
  id: number
  /** 原图在磁盘上的路径。**不是缩略图**——缩略图只有 256×256，看不清细节。 */
  imagePath: string
  createdAt: string
}

/**
 * 剪贴板图片查看器，两种呈现（默认 fullscreen）：fullscreen 盖满窗口的遮罩，window
 * 不遮罩的浮层可边看边操作列表。
 * 交互：滚轮缩放、拖动、双击在 1:1 与适应窗口间切、Esc 关、←/→ 翻图、点图把原图复制到系统剪贴板。
 * 显示 imagePath 而非列表缩略图：缩略图入库时已压到 256×256 内（clipboard/service.py
 * THUMBNAIL_MAX_SIZE），放大只会糊。
 */
export function ClipboardImageViewer({
  images,
  index,
  mode,
  onIndexChange,
  onModeChange,
  onCopy,
  onClose,
}: {
  images: ViewerImage[]
  index: number
  mode: ClipboardImageViewMode
  onIndexChange: (next: number) => void
  onModeChange: (mode: ClipboardImageViewMode) => void
  /** 把这一条的原图放回系统剪贴板（不触发粘贴）。 */
  onCopy: (image: ViewerImage) => void
  onClose: () => void
}) {
  const { t } = useTranslation('clipboard')
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragState = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  // 区分"拖动"和"点击"：拖完松手不该被当成一次点击而去复制图片。
  const draggedRef = useRef(false)

  const current = images[index]

  const resetView = useCallback(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  // 换一张图就把缩放和位移复位——沿用上一张的缩放会让新图开局就在画布外面。
  useEffect(() => {
    resetView()
  }, [index, resetView])

  const goTo = useCallback(
    (delta: number) => {
      if (images.length < 2) return
      // 环形翻页：到头再按就回到另一端，比"按了没反应"好判断
      onIndexChange((index + delta + images.length) % images.length)
    },
    [images.length, index, onIndexChange],
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goTo(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goTo(1)
      }
    }
    // 挂在 window 上而不是容器上：容器可能还没拿到焦点，而 Esc 要立刻能用。
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goTo, onClose])

  if (!current) return null

  const fullscreen = mode === 'fullscreen'

  return (
    <div
      className={cn(
        'fixed z-50 flex flex-col overflow-hidden',
        fullscreen
          ? 'inset-0 bg-black/85 backdrop-blur-sm'
          : 'end-6 bottom-6 h-[26rem] w-[34rem] rounded-xl border border-border bg-card shadow-2xl',
      )}
      // 只有全屏模式点背景才关闭。窗口模式是个浮层，点它自己的空白处关掉会很意外。
      onClick={fullscreen ? onClose : undefined}
      role="dialog"
      aria-modal={fullscreen}
      aria-label={t('imageViewerTitle')}
    >
      <div
        className={cn(
          'flex shrink-0 items-center justify-between gap-2 px-3 py-2',
          fullscreen ? 'text-white' : 'border-b border-border',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <span className={cn('text-sm tabular', fullscreen ? 'text-white/80' : 'text-muted-foreground')}>
          {images.length > 1 ? `${index + 1} / ${images.length} · ` : ''}
          {Math.round(zoom * 100)}%
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={fullscreen ? 'ghost' : 'outline'}
            className={fullscreen ? 'text-white hover:bg-white/15 hover:text-white' : undefined}
            onClick={() => onCopy(current)}
            title={t('imageViewerCopyHint')}
          >
            <Copy className="size-4" />
            {t('imageViewerCopyButton')}
          </Button>
          {/* 这两颗是纯图标，名字只能靠悬停提示。原生 title= 要等约一秒才弹、
              样式还是系统灰底，跟应用里别处对不上——用户的感受是"悬停没反应"。 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant={fullscreen ? 'ghost' : 'outline'}
                className={fullscreen ? 'text-white hover:bg-white/15 hover:text-white' : undefined}
                onClick={() => {
                  const next: ClipboardImageViewMode = fullscreen ? 'window' : 'fullscreen'
                  saveClipboardImageViewMode(next)
                  onModeChange(next)
                }}
                aria-label={fullscreen ? t('imageViewerToWindowHint') : t('imageViewerToFullscreenHint')}
              >
                {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {fullscreen ? t('imageViewerToWindowHint') : t('imageViewerToFullscreenHint')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant={fullscreen ? 'ghost' : 'outline'}
                className={fullscreen ? 'text-white hover:bg-white/15 hover:text-white' : undefined}
                onClick={onClose}
                aria-label={t('imageViewerCloseHint')}
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('imageViewerCloseHint')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => setZoom((z) => zoomByWheel(z, e.deltaY))}
        onPointerDown={(e) => {
          draggedRef.current = false
          dragState.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = dragState.current
          if (!d) return
          const dx = e.clientX - d.x
          const dy = e.clientY - d.y
          // 3px 的死区：手指/鼠标点下去总会抖一两个像素，没有死区的话每次点击
          // 都会被判成拖动，"点图复制"就永远触发不了。
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) draggedRef.current = true
          setOffset({ x: d.ox + dx, y: d.oy + dy })
        }}
        onPointerUp={(e) => {
          dragState.current = null
          e.currentTarget.releasePointerCapture(e.pointerId)
        }}
      >
        {images.length > 1 && (
          <>
            <ViewerNavButton side="start" fullscreen={fullscreen} onClick={() => goTo(-1)} label={t('imageViewerPrev')} />
            <ViewerNavButton side="end" fullscreen={fullscreen} onClick={() => goTo(1)} label={t('imageViewerNext')} />
          </>
        )}
        <img
          src={`file://${current.imagePath}`}
          alt={t('imageAlt')}
          draggable={false}
          className="max-h-full max-w-full cursor-pointer select-none object-contain"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          onDoubleClick={() => (zoom === 1 ? setZoom(clampZoom(2)) : resetView())}
          onClick={() => {
            // 拖动结束的那一下也会触发 click，靠死区标志把它挡掉
            if (draggedRef.current) return
            onCopy(current)
          }}
        />
      </div>

      <p
        className={cn('shrink-0 px-3 py-2 text-center text-sm', fullscreen ? 'text-white/70' : 'text-muted-foreground')}
        onClick={(e) => e.stopPropagation()}
      >
        {t('imageViewerHint')}
      </p>
    </div>
  )
}

function ViewerNavButton({
  side,
  fullscreen,
  onClick,
  label,
}: {
  side: 'start' | 'end'
  fullscreen: boolean
  onClick: () => void
  label: string
}) {
  const Icon = side === 'start' ? ChevronLeft : ChevronRight
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          // 用 start/end 而不是 left/right：阿拉伯语是从右往左排的，写死 left
          // 会让"上一张"跑到视觉上的"下一张"位置。
          className={cn(
            'absolute top-1/2 z-10 -translate-y-1/2 rounded-full p-2 transition-colors',
            side === 'start' ? 'start-2' : 'end-2',
            fullscreen ? 'bg-black/40 text-white hover:bg-black/70' : 'bg-surface-strong hover:bg-accent',
          )}
        >
          <Icon className="size-5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
