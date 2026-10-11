import * as React from "react"
import { Menubar as MenubarPrimitive } from "radix-ui"
import { Check, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

// 顶栏菜单薄封装，样式与 dropdown-menu.tsx 逐字对齐。用 Menubar 而非一排独立 DropdownMenu：
// 它有"一行菜单"的语义（展开后滑到隔壁触发器直接切换、左右方向键、读屏"第 2 项共 5 项"）。
// 每个包装都必须 forwardRef，理由见 dropdown-menu.tsx 顶部。

const Menubar = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.Root>,
  React.ComponentProps<typeof MenubarPrimitive.Root>
>(function Menubar({ className, ...props }, ref) {
  return (
    <MenubarPrimitive.Root
      ref={ref}
      data-slot="menubar"
      className={cn("flex items-center gap-0.5", className)}
      {...props}
    />
  )
})

function MenubarMenu(props: React.ComponentProps<typeof MenubarPrimitive.Menu>) {
  return <MenubarPrimitive.Menu data-slot="menubar-menu" {...props} />
}

const MenubarTrigger = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.Trigger>,
  React.ComponentProps<typeof MenubarPrimitive.Trigger>
>(function MenubarTrigger({ className, ...props }, ref) {
  return (
    <MenubarPrimitive.Trigger
      ref={ref}
      data-slot="menubar-trigger"
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium whitespace-nowrap outline-hidden select-none transition-colors",
        "text-foreground/85 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
        "data-[state=open]:bg-muted data-[state=open]:text-foreground",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
})

const MENU_SURFACE =
  "z-50 overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"

const MenubarContent = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.Content>,
  React.ComponentProps<typeof MenubarPrimitive.Content>
>(function MenubarContent({ className, align = "start", sideOffset = 6, alignOffset = -2, ...props }, ref) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.Content
        ref={ref}
        data-slot="menubar-content"
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className={cn(
          MENU_SURFACE,
          "max-h-(--radix-menubar-content-available-height) min-w-52 origin-(--radix-menubar-content-transform-origin) data-[side=bottom]:slide-in-from-top-2",
          className
        )}
        {...props}
      />
    </MenubarPrimitive.Portal>
  )
})

const ITEM_CLASS =
  "relative flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

const MenubarItem = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.Item>,
  React.ComponentProps<typeof MenubarPrimitive.Item> & { destructive?: boolean }
>(function MenubarItem({ className, destructive, ...props }, ref) {
  return (
    <MenubarPrimitive.Item
      ref={ref}
      data-slot="menubar-item"
      className={cn(ITEM_CLASS, destructive && "text-destructive focus:bg-destructive/10 focus:text-destructive", className)}
      {...props}
    />
  )
})

const MenubarCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.CheckboxItem>,
  React.ComponentProps<typeof MenubarPrimitive.CheckboxItem>
>(function MenubarCheckboxItem({ className, children, ...props }, ref) {
  return (
    <MenubarPrimitive.CheckboxItem
      ref={ref}
      data-slot="menubar-checkbox-item"
      className={cn(ITEM_CLASS, "pl-8", className)}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <MenubarPrimitive.ItemIndicator>
          <Check className="size-4" />
        </MenubarPrimitive.ItemIndicator>
      </span>
      {children}
    </MenubarPrimitive.CheckboxItem>
  )
})

const MenubarLabel = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.Label>,
  React.ComponentProps<typeof MenubarPrimitive.Label>
>(function MenubarLabel({ className, ...props }, ref) {
  return (
    <MenubarPrimitive.Label
      ref={ref}
      data-slot="menubar-label"
      className={cn("px-2 pt-2 pb-1 text-sm font-medium tracking-wide text-muted-foreground", className)}
      {...props}
    />
  )
})

const MenubarSeparator = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.Separator>,
  React.ComponentProps<typeof MenubarPrimitive.Separator>
>(function MenubarSeparator({ className, ...props }, ref) {
  return (
    <MenubarPrimitive.Separator
      ref={ref}
      data-slot="menubar-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
})

function MenubarSub(props: React.ComponentProps<typeof MenubarPrimitive.Sub>) {
  return <MenubarPrimitive.Sub data-slot="menubar-sub" {...props} />
}

const MenubarSubTrigger = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.SubTrigger>,
  React.ComponentProps<typeof MenubarPrimitive.SubTrigger>
>(function MenubarSubTrigger({ className, children, ...props }, ref) {
  return (
    <MenubarPrimitive.SubTrigger
      ref={ref}
      data-slot="menubar-sub-trigger"
      className={cn(
        ITEM_CLASS,
        "data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
    </MenubarPrimitive.SubTrigger>
  )
})

const MenubarSubContent = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.SubContent>,
  React.ComponentProps<typeof MenubarPrimitive.SubContent>
>(function MenubarSubContent({ className, sideOffset = 4, alignOffset = -5, ...props }, ref) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.SubContent
        ref={ref}
        data-slot="menubar-sub-content"
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className={cn(
          MENU_SURFACE,
          "max-h-[min(28rem,var(--radix-menubar-content-available-height))] min-w-48 origin-(--radix-menubar-content-transform-origin)",
          className
        )}
        {...props}
      />
    </MenubarPrimitive.Portal>
  )
})

export {
  Menubar,
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarCheckboxItem,
  MenubarLabel,
  MenubarSeparator,
  MenubarSub,
  MenubarSubTrigger,
  MenubarSubContent,
}
