import { useEffect, useRef } from "react"
import type { ReactNode } from "react"
import { XIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { categoryName, currencies } from "@/lib/api"
import type { Category } from "@/lib/api"

export function Modal({
  title,
  children,
  close,
}: {
  title: string
  children: ReactNode
  close: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return (
    <dialog ref={ref} className="modal" onCancel={close} aria-label={title}>
      <div className="modal-head">
        <h2>{title}</h2>
        <Button variant="ghost" size="icon" onClick={close} aria-label="关闭">
          <XIcon size={18} />
        </Button>
      </div>
      {children}
    </dialog>
  )
}
export function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}
export function CategorySelect({
  categories,
  value,
  onChange,
  all = false,
}: {
  categories: Category[]
  value: string
  onChange: (v: string) => void
  all?: boolean
}) {
  const visible = categories.filter(
    (c) =>
      !c.archived &&
      (!c.parent_id || !categories.find((p) => p.id === c.parent_id)?.archived)
  )
  return (
    <select
      aria-label={all ? "筛选分类" : "类别"}
      required={!all}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{all ? "全部分类" : "选择类别"}</option>
      {visible
        .filter((c) => !c.parent_id)
        .map((p) => (
          <optgroup key={p.id} label={p.name}>
            <option value={p.id}>{p.name}</option>
            {visible
              .filter((c) => c.parent_id === p.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryName(categories, c.id)}
                </option>
              ))}
          </optgroup>
        ))}
      {value && !visible.some((c) => c.id === value) && (
        <option value={value}>
          {categoryName(categories, value)}（已归档）
        </option>
      )}
    </select>
  )
}
export function CurrencySelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <select
      aria-label="币种"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {currencies.map((c) => (
        <option key={c}>{c}</option>
      ))}
    </select>
  )
}
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-mark">—</div>
      {children}
    </div>
  )
}
