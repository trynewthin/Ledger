import { useTask } from "@/lib/use-task"
import { useRef, useState } from "react"
import { ArrowRightIcon, CaretDownIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CategorySelect, CurrencySelect, Field } from "./shared"
import { action, emptyEntry } from "@/lib/api"
import type { Category, Entry } from "@/lib/api"

export function EntryForm({
  categories,
  initial,
  done,
}: {
  categories: Category[]
  initial?: Entry
  done: () => void
}) {
  const [entry, setEntry] = useState<Entry>(initial ?? emptyEntry())
  const [expanded, setExpanded] = useState(!!initial)
  const [reason, setReason] = useState("")
  const { busy, error, run } = useTask()
  const pending = useRef<{ signature: string; key: string } | null>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const update = (key: keyof Entry, value: string) =>
    setEntry((v) => ({ ...v, [key]: value }))
  async function save() {
    if (initial) await action("entries_update", { entry, reason })
    else {
      const signature = JSON.stringify(entry)
      if (pending.current?.signature !== signature)
        pending.current = { signature, key: crypto.randomUUID() }
      await action("entries_add", { entry, request_id: pending.current.key })
      pending.current = null
      setEntry((v) => ({
        ...emptyEntry(),
        category_id: v.category_id,
        date: v.date,
        currency: v.currency,
        kind: v.kind,
      }))
      amountRef.current?.focus()
    }
    done()
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void run(save)
      }}
      className={initial ? "edit-form" : "quick-form"}
    >
      <div className="entry-line">
        <Field label="金额">
          <div className="amount-input">
            <span>{entry.currency === "CNY" ? "¥" : entry.currency}</span>
            <Input
              ref={amountRef}
              aria-label="金额"
              inputMode="decimal"
              value={entry.amount}
              onChange={(e) => update("amount", e.target.value)}
              placeholder="0.00"
              required
              pattern="[0-9]+(\.[0-9]{1,2})?"
            />
          </div>
        </Field>
        <Field label="类别">
          <CategorySelect
            categories={categories}
            value={entry.category_id}
            onChange={(v) => update("category_id", v)}
          />
        </Field>
        <Field label="日期">
          <Input
            type="date"
            aria-label="日期"
            value={entry.date}
            onChange={(e) => update("date", e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy} className="save-entry">
          {busy ? "保存中…" : initial ? "保存修改" : "记一笔"}
          <ArrowRightIcon size={17} />
        </Button>
      </div>
      <button
        className="more-fields"
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <CaretDownIcon size={13} />
        {expanded ? "收起选填项" : "备注、商家及更多"}
      </button>
      {expanded && (
        <div className="form-grid">
          <Field label="收支类型">
            <select
              value={entry.kind}
              onChange={(e) => update("kind", e.target.value)}
            >
              <option value="expense">支出</option>
              <option value="income">收入</option>
            </select>
          </Field>
          <Field label="币种">
            <CurrencySelect
              value={entry.currency}
              onChange={(v) => update("currency", v)}
            />
          </Field>
          {entry.currency !== "CNY" && (
            <Field label="折合人民币（可稍后补填）">
              <Input
                inputMode="decimal"
                value={entry.cny_amount}
                onChange={(e) => update("cny_amount", e.target.value)}
                placeholder="尚未折算"
              />
            </Field>
          )}
          <Field label="商家">
            <Input
              value={entry.merchant}
              maxLength={100}
              onChange={(e) => update("merchant", e.target.value)}
              placeholder="例如：楼下咖啡店"
            />
          </Field>
          <Field label="备注">
            <Input
              value={entry.note}
              maxLength={1000}
              onChange={(e) => update("note", e.target.value)}
              placeholder="补充一点细节"
            />
          </Field>
          {initial && (
            <Field label="调整原因（选填）">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  )
}
