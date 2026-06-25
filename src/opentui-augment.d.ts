import '@opentui/core'

declare module '@opentui/core' {
  interface ProxiedVNode<T> {
    add(child: unknown): void
    remove(id: string): void
    getChildren(): { id: string }[]
    findDescendantById(id: string): ProxiedVNode<any> | null
    requestRender(): void
    visible: boolean
    width: number | string
    height: number | string
    right: number
    title: string
    onKeyboardEvent(event: { name: string; ctrl: boolean; shift: boolean; meta: boolean; sequence?: string }): void
  }

  interface Renderer {
    on(event: string, handler: (...args: any[]) => void): void
    getSelection(): { getSelectedText(): string } | null
    currentFocusedRenderable: Renderable | null
    copyToClipboardOSC52(text: string): boolean
  }
}
